import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { report } from "../../../scripts/operations-report";

config({ path: ".env.local", quiet: true });
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("operations", () => {
  let pool: Pool;
  const owner = randomUUID();
  const other = randomUUID();
  const order = randomUUID();
  const payment = `pay-${randomUUID()}`;

  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/precopronto_integration") throw new Error("Banco de teste isolado obrigatório.");
    pool = new Pool({ connectionString: url.toString() });
    const migration = await readFile(new URL("../../../migrations/0010_operations.sql", import.meta.url), "utf8");
    await pool.query(migration);
    for (const id of [owner, other]) {
      await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent)
        VALUES ($1, 'Teste', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
      [id, `${id}@precopronto.test`]);
    }
    await pool.query(`INSERT INTO billing_order
      (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
      VALUES ($1, $2, $3, 'pix', 2990, 'BRL', 'paid', NOW(), NOW())`,
    [order, owner, `billing-order:${order}`]);
    await pool.query(`INSERT INTO billing_payment_cycle
      (payment_id, order_id, user_id, period_end, state, is_initial)
      VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', TRUE)`,
    [payment, order, owner]);
    await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
      VALUES ($1, $2, 'PAYMENT_RECEIVED', 'confirmed')`, [`event-${randomUUID()}`, payment]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM billing_payment_event WHERE payment_id = $1", [payment]);
    await pool.query("DELETE FROM billing_order WHERE id = $1", [order]);
    await pool.query('DELETE FROM "user" WHERE id = ANY($1::TEXT[])', [[owner, other]]);
    await pool.query("DELETE FROM access_change_audit WHERE user_id = ANY($1::TEXT[])", [[owner, other]]);
    await pool.end();
  });

  it("report_owner_isolated_and_payment_deduplicated", async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
      VALUES ($1, $2, 'PAYMENT_RECEIVED', 'confirmed')`, [`event-${randomUUID()}`, payment]);
    const own = await report(pool, since, owner);
    const foreign = await report(pool, since, other);
    expect(own.financial).toEqual([expect.objectContaining({
      stream: "pix_manual", gross_cycles: 1, gross_confirmed_cents: "2990",
      received_cycles: 1, provider_received_cents: "2990",
    })]);
    expect(foreign.financial).toEqual([]);
    expect(foreign.account).toMatchObject({ id: other, confirmed_cycles: 0 });
    expect(own.events).toContainEqual({ event_type: "signup_verified", count: 1 });
    expect(foreign.events).toContainEqual({ event_type: "signup_verified", count: 1 });
  });

  it("operator_change_records_actor_reason_and_expiry", async () => {
    const expires = new Date(Date.now() + 86_400_000);
    await pool.query("SELECT set_operator_entitlement($1, 'pro', $2, $3, $4)",
      [owner, expires, "operator-test", "verified test correction"]);
    const audit = await pool.query(`SELECT actor, reason, new_plan, new_expires_at
      FROM access_change_audit WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [owner]);
    expect(audit.rows[0]).toMatchObject({ actor: "operator-test", reason: "verified test correction", new_plan: "pro" });
    expect(new Date(audit.rows[0].new_expires_at).getTime()).toBe(expires.getTime());
    await expect(pool.query("SELECT set_operator_entitlement($1, 'pro', NULL, $2, $3)",
      [owner, "operator-test", "invalid no expiry"])).rejects.toThrow();
  });

  it("initial_payment_preserves_old_paid_at_and_excludes_from_current_window", async () => {
    const user = randomUUID();
    const orderId = randomUUID();
    const paymentId = `pay-${randomUUID()}`;
    const oldPaidAt = new Date("2024-01-10T10:00:00Z");
    const recentReceivedAt = new Date("2026-10-01T10:00:00Z");

    try {
      await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent)
        VALUES ($1, 'Old Paid Test', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
        [user, `${user}@precopronto.test`]);

      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'pix', 2990, 'BRL', 'paid', NOW(), $4)`,
        [orderId, user, `billing-order:${orderId}`, oldPaidAt]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', TRUE)`,
        [paymentId, orderId, user]);

      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'paid_duplicate_financial', $3)`,
        [`event-${randomUUID()}`, paymentId, recentReceivedAt]);

      const res = await pool.query(
        `SELECT occurred_at FROM operational_funnel_event WHERE user_id = $1 AND event_type = 'payment_confirmed'`,
        [user]
      );
      expect(res.rows).toHaveLength(1);
      expect(new Date(res.rows[0].occurred_at).toISOString()).toBe(oldPaidAt.toISOString());

      const windowRes = await pool.query(
        `SELECT occurred_at FROM operational_funnel_event WHERE user_id = $1 AND event_type = 'payment_confirmed' AND occurred_at >= '2026-01-01T00:00:00Z'`,
        [user]
      );
      expect(windowRes.rows).toHaveLength(0);
    } finally {
      await pool.query("DELETE FROM billing_payment_event WHERE payment_id = $1", [paymentId]);
      await pool.query("DELETE FROM billing_order WHERE id = $1", [orderId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [user]);
    }
  });

  it("renewal_cycle_preserves_first_confirmation_timestamp_and_unique_count", async () => {
    const user = randomUUID();
    const orderId = randomUUID();
    const paymentId = `pay-${randomUUID()}`;
    const oldConfirmedAt = new Date("2024-03-01T10:00:00Z");
    const posteriorReceivedAt = new Date("2024-03-05T10:00:00Z");

    try {
      await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent)
        VALUES ($1, 'Renewal Test', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
        [user, `${user}@precopronto.test`]);

      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'card', 2990, 'BRL', 'paid', NOW(), NOW())`,
        [orderId, user, `billing-order:${orderId}`]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial, updated_at)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', FALSE, NOW())`,
        [paymentId, orderId, user]);

      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_CONFIRMED', 'confirmed', $3)`,
        [`event-${randomUUID()}`, paymentId, oldConfirmedAt]);

      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'paid_duplicate_financial', $3)`,
        [`event-${randomUUID()}`, paymentId, posteriorReceivedAt]);

      await pool.query(`UPDATE billing_payment_cycle SET updated_at = NOW() WHERE payment_id = $1`, [paymentId]);

      const res = await pool.query(
        `SELECT occurred_at FROM operational_funnel_event WHERE user_id = $1 AND event_type = 'renewal_confirmed'`,
        [user]
      );
      expect(res.rows).toHaveLength(1);
      expect(new Date(res.rows[0].occurred_at).toISOString()).toBe(oldConfirmedAt.toISOString());
    } finally {
      await pool.query("DELETE FROM billing_payment_event WHERE payment_id = $1", [paymentId]);
      await pool.query("DELETE FROM billing_order WHERE id = $1", [orderId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [user]);
    }
  });

  it("refunded_and_chargeback_cycles_preserve_historical_events", async () => {
    const user = randomUUID();
    const orderId = randomUUID();
    const paymentRefund = `pay-${randomUUID()}`;
    const paymentChargeback = `pay-${randomUUID()}`;
    const historicalDate1 = new Date("2024-04-01T10:00:00Z");
    const historicalDate2 = new Date("2024-04-15T10:00:00Z");

    try {
      await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent)
        VALUES ($1, 'Refund Chargeback Test', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
        [user, `${user}@precopronto.test`]);

      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'card', 2990, 'BRL', 'paid', NOW(), $4)`,
        [orderId, user, `billing-order:${orderId}`, historicalDate1]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'refunded', TRUE)`,
        [paymentRefund, orderId, user]);
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_CONFIRMED', 'confirmed', $3)`,
        [`event-${randomUUID()}`, paymentRefund, historicalDate1]);
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_REFUNDED', 'refunded', NOW())`,
        [`event-${randomUUID()}`, paymentRefund]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '2 months', 'chargeback', FALSE)`,
        [paymentChargeback, orderId, user]);
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_CONFIRMED', 'confirmed', $3)`,
        [`event-${randomUUID()}`, paymentChargeback, historicalDate2]);
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_CHARGEBACK_REQUESTED', 'chargeback', NOW())`,
        [`event-${randomUUID()}`, paymentChargeback]);

      const res = await pool.query(
        `SELECT event_type, occurred_at FROM operational_funnel_event
         WHERE user_id = $1 AND event_type IN ('payment_confirmed', 'renewal_confirmed')
         ORDER BY occurred_at ASC`,
        [user]
      );
      expect(res.rows).toEqual([
        { event_type: "payment_confirmed", occurred_at: historicalDate1 },
        { event_type: "renewal_confirmed", occurred_at: historicalDate2 },
      ]);
    } finally {
      await pool.query("DELETE FROM billing_payment_event WHERE payment_id = ANY($1::TEXT[])", [[paymentRefund, paymentChargeback]]);
      await pool.query("DELETE FROM billing_order WHERE id = $1", [orderId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [user]);
    }
  });

  it("renewal_cycle_without_financial_evidence_generates_no_event", async () => {
    const user = randomUUID();
    const orderId = randomUUID();
    const paymentId = `pay-${randomUUID()}`;

    try {
      await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent)
        VALUES ($1, 'Renewal No Financial Evidence', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
        [user, `${user}@precopronto.test`]);

      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'card', 2990, 'BRL', 'paid', NOW(), NOW())`,
        [orderId, user, `billing-order:${orderId}`]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', FALSE)`,
        [paymentId, orderId, user]);

      const res = await pool.query(
        `SELECT * FROM operational_funnel_event WHERE user_id = $1 AND event_type = 'renewal_confirmed'`,
        [user]
      );
      expect(res.rows).toHaveLength(0);
    } finally {
      await pool.query("DELETE FROM billing_order WHERE id = $1", [orderId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [user]);
    }
  });

  it("reapply_migration_0010_is_idempotent_and_preserves_data_and_timestamps", async () => {
    const user = randomUUID();
    const orderId = randomUUID();
    const paymentId = `pay-${randomUUID()}`;
    const targetDate = new Date("2024-07-20T14:30:00Z");

    try {
      await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent)
        VALUES ($1, 'Migration Idempotence Test', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
        [user, `${user}@precopronto.test`]);

      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'card', 2990, 'BRL', 'paid', NOW(), $4)`,
        [orderId, user, `billing-order:${orderId}`, targetDate]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', TRUE)`,
        [paymentId, orderId, user]);

      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome, received_at)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'confirmed', $3)`,
        [`event-${randomUUID()}`, paymentId, targetDate]);

      const before = await pool.query(
        `SELECT event_type, occurred_at FROM operational_funnel_event WHERE user_id = $1 AND event_type = 'payment_confirmed'`,
        [user]
      );
      expect(before.rows).toHaveLength(1);
      expect(new Date(before.rows[0].occurred_at).toISOString()).toBe(targetDate.toISOString());

      const migration = await readFile(new URL("../../../migrations/0010_operations.sql", import.meta.url), "utf8");
      await pool.query(migration);

      const after = await pool.query(
        `SELECT event_type, occurred_at FROM operational_funnel_event WHERE user_id = $1 AND event_type = 'payment_confirmed'`,
        [user]
      );
      expect(after.rows).toHaveLength(1);
      expect(new Date(after.rows[0].occurred_at).toISOString()).toBe(targetDate.toISOString());
      expect(after.rows[0].event_type).toBe(before.rows[0].event_type);
      expect(after.rows).toHaveLength(1);
      expect(new Date(after.rows[0].occurred_at).toISOString()).toBe(targetDate.toISOString());
      expect(after.rows[0].event_type).toBe(before.rows[0].event_type);
    } finally {
      await pool.query("DELETE FROM billing_payment_event WHERE payment_id = $1", [paymentId]);
      await pool.query("DELETE FROM billing_order WHERE id = $1", [orderId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [user]);
    }
  });

  it("report_counts_received_and_duplicate_once_with_exact_totals_excludes_rejected_and_isolates_users", async () => {
    const user1 = randomUUID();
    const userOther = randomUUID();
    const order1 = randomUUID();
    const orderOther = randomUUID();
    const payment1 = `pay-${randomUUID()}`;
    const paymentOther = `pay-${randomUUID()}`;

    try {
      for (const u of [user1, userOther]) {
        await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt",
          terms_accepted, terms_version, privacy_version, marketing_consent)
          VALUES ($1, 'Report Test', $2, TRUE, NOW(), NOW(), TRUE, 'test', 'test', FALSE)`,
          [u, `${u}@precopronto.test`]);
      }

      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'pix', 2990, 'BRL', 'paid', NOW(), NOW())`,
        [order1, user1, `billing-order:${order1}`]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', TRUE)`,
        [payment1, order1, user1]);

      // Initially only PAYMENT_RECEIVED/paid_duplicate_financial for user1 (without initial confirmed)
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'paid_duplicate_financial')`,
        [`event-${randomUUID()}`, payment1]);

      // Other user fixture: only rejected_correlation and paid_without_entitlement (no received confirmation)
      await pool.query(`INSERT INTO billing_order
        (id, user_id, external_reference, method, amount_cents, currency, status, checkout_expires_at, paid_at)
        VALUES ($1, $2, $3, 'pix', 2990, 'BRL', 'paid', NOW(), NOW())`,
        [orderOther, userOther, `billing-order:${orderOther}`]);

      await pool.query(`INSERT INTO billing_payment_cycle
        (payment_id, order_id, user_id, period_end, state, is_initial)
        VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', 'confirmed', TRUE)`,
        [paymentOther, orderOther, userOther]);

      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'rejected_correlation')`,
        [`event-${randomUUID()}`, paymentOther]);
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'paid_without_entitlement')`,
        [`event-${randomUUID()}`, paymentOther]);

      const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const rep1 = await report(pool, since, user1);
      const repOther = await report(pool, since, userOther);

      // rep1 initially counts received_cycles=1 and provider_received_cents=2990
      expect(rep1.financial).toEqual([expect.objectContaining({
        stream: "pix_manual",
        gross_cycles: 1,
        gross_confirmed_cents: "2990",
        received_cycles: 1,
        provider_received_cents: "2990",
      })]);

      // repOther has no received confirmation: received_cycles=0, provider_received_cents=0, gross confirmed=2990
      expect(repOther.financial).toEqual([expect.objectContaining({
        stream: "pix_manual",
        gross_cycles: 1,
        gross_confirmed_cents: "2990",
        received_cycles: 0,
        provider_received_cents: "0",
      })]);

      // Later insert confirmed + new paid_duplicate_financial with distinct IDs and assert identical financial report (dedup)
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'confirmed')`,
        [`event-${randomUUID()}`, payment1]);
      await pool.query(`INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
        VALUES ($1, $2, 'PAYMENT_RECEIVED', 'paid_duplicate_financial')`,
        [`event-${randomUUID()}`, payment1]);

      const rep1AfterDedup = await report(pool, since, user1);
      expect(rep1AfterDedup.financial).toEqual(rep1.financial);
    } finally {
      await pool.query("DELETE FROM billing_payment_event WHERE payment_id = ANY($1::TEXT[])", [[payment1, paymentOther]]);
      await pool.query("DELETE FROM billing_order WHERE id = ANY($1::TEXT[])", [[order1, orderOther]]);
      await pool.query('DELETE FROM "user" WHERE id = ANY($1::TEXT[])', [[user1, userOther]]);
    }
  });
});
