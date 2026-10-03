import { config } from "dotenv";
import { Pool } from "pg";

config({ path: ".env.local", quiet: true });

export function argumentsForReport(args: string[]): { since: string; accountId?: string; check: boolean } {
  const values = new Map<string, string>();
  for (const arg of args) {
    if (arg === "--check" && !values.has("check")) {
      values.set("check", "true");
      continue;
    }
    const match = /^--(since|account-id|lookback-minutes)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error("Argumentos inválidos.");
    values.set(match[1], match[2]);
  }
  const lookback = values.get("lookback-minutes");
  if (Boolean(lookback) === Boolean(values.get("since"))) {
    throw new Error("Use --since=AAAA-MM-DD ou --lookback-minutes=1..1440.");
  }
  if (lookback && (!/^\d+$/.test(lookback) || Number(lookback) < 1 || Number(lookback) > 1440)) {
    throw new Error("Janela de consulta inválida.");
  }
  const since = lookback
    ? new Date(Date.now() - Number(lookback) * 60_000).toISOString()
    : values.get("since")!;
  if (!lookback && (!/^\d{4}-\d{2}-\d{2}$/.test(since) ||
    Number.isNaN(Date.parse(`${since}T00:00:00Z`)) ||
    new Date(`${since}T00:00:00Z`).toISOString().slice(0, 10) !== since)) {
    throw new Error("Data inicial inválida.");
  }
  const accountId = values.get("account-id");
  if (accountId && !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) {
    throw new Error("Identificador de conta inválido.");
  }
  if (accountId && values.has("check")) throw new Error("Verificação exige escopo global.");
  return { since, ...(accountId ? { accountId } : {}), check: values.has("check") };
}

export async function report(pool: Pool, since: string, accountId?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const events = await client.query(`
      SELECT event_type, count(*)::INT AS count
      FROM operational_funnel_event
      WHERE occurred_at >= $1::TIMESTAMPTZ AND ($2::TEXT IS NULL OR user_id = $2)
      GROUP BY event_type ORDER BY event_type
    `, [since, accountId ?? null]);
    const financial = await client.query(`
      WITH cycles AS (
        SELECT c.user_id, c.state, c.is_initial, b.method, b.amount_cents,
          LEAST((SELECT min(e.received_at) FROM billing_payment_event e
            WHERE e.payment_id = c.payment_id AND e.event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED')
              AND e.outcome IN ('confirmed', 'paid_duplicate_financial')),
            CASE WHEN c.is_initial THEN b.paid_at END) AS first_confirmed_at,
          EXISTS (SELECT 1 FROM billing_payment_event e WHERE e.payment_id = c.payment_id
            AND e.event_type = 'PAYMENT_RECEIVED' AND e.outcome IN ('confirmed', 'paid_duplicate_financial')) AS received
        FROM billing_payment_cycle c JOIN billing_order b ON b.id = c.order_id
        WHERE ($2::TEXT IS NULL OR c.user_id = $2)
      )
      SELECT CASE WHEN method = 'pix' THEN 'pix_manual'
        WHEN is_initial THEN 'card_initial' ELSE 'card_recurring' END AS stream,
        count(*)::INT AS gross_cycles,
        sum(amount_cents)::BIGINT AS gross_confirmed_cents,
        count(*) FILTER (WHERE received)::INT AS received_cycles,
        COALESCE(sum(amount_cents) FILTER (WHERE received), 0)::BIGINT AS provider_received_cents,
        COALESCE(sum(amount_cents) FILTER (WHERE state IN ('refunded', 'chargeback')), 0)::BIGINT AS reversed_cents,
        COALESCE(sum(amount_cents) FILTER (WHERE state = 'confirmed'), 0)::BIGINT AS currently_confirmed_cents
      FROM cycles WHERE first_confirmed_at >= $1::TIMESTAMPTZ
      GROUP BY stream ORDER BY stream
    `, [since, accountId ?? null]);
    const failures = await client.query(`
      SELECT 'checkout_failed' AS kind, count(*)::INT AS count FROM billing_order
        WHERE status = 'failed' AND updated_at >= $1::TIMESTAMPTZ
          AND ($2::TEXT IS NULL OR user_id = $2)
      UNION ALL SELECT 'payment_exception', count(*)::INT FROM billing_payment_event e
        LEFT JOIN billing_payment_cycle c ON c.payment_id = e.payment_id
        WHERE e.received_at >= $1::TIMESTAMPTZ
          AND e.outcome IN ('rejected_correlation', 'paid_without_entitlement', 'overdue')
          AND ($2::TEXT IS NULL OR c.user_id = $2)
      UNION ALL SELECT 'unattributed_access_change', count(*)::INT FROM access_change_audit
        WHERE changed_at >= $1::TIMESTAMPTZ AND actor = 'unattributed'
          AND ($2::TEXT IS NULL OR user_id = $2)
      UNION ALL SELECT kind, count(*)::INT FROM operational_failure_event
        WHERE created_at >= $1::TIMESTAMPTZ AND $2::TEXT IS NULL GROUP BY kind
    `, [since, accountId ?? null]);
    const account = accountId ? await client.query(`
      SELECT u.id, u."emailVerified" AS verified, a.plan, a.expires_at,
        (SELECT count(*)::INT FROM billing_order b WHERE b.user_id = u.id) AS orders,
        (SELECT count(*)::INT FROM billing_payment_cycle c WHERE c.user_id = u.id
          AND c.state = 'confirmed') AS confirmed_cycles,
        (SELECT count(*)::INT FROM access_change_audit h WHERE h.user_id = u.id) AS access_changes
      FROM "user" u LEFT JOIN account_entitlement a ON a.user_id = u.id WHERE u.id = $1
    `, [accountId]) : null;
    await client.query("COMMIT");
    return { environment: process.env.APP_ENV ?? "unknown", provider: process.env.ASAAS_ENV ?? "unknown",
      since, events: events.rows, financial: financial.rows, failures: failures.rows,
      ...(accountId ? { account: account?.rows[0] ?? null } : {}) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const url = process.env.OPERATIONS_DATABASE_URL;
  if (!url) throw new Error("Credencial de leitura operacional indisponível.");
  const { since, accountId, check } = argumentsForReport(process.argv.slice(2));
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const result = await report(pool, since, accountId);
    console.log(JSON.stringify(result));
    if (check && (result.failures.some((item) => Number(item.count) > 0) ||
      result.events.some((item) => item.event_type === "calculation_error" && Number(item.count) > 0))) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("operations-report.ts")) {
  void main().catch(() => {
    console.error("Consulta operacional falhou; confira credencial, migração e parâmetros.");
    process.exitCode = 1;
  });
}
