import type { PoolClient } from "pg";

import {
  createAsaasSandboxSubscriptionClient,
  type AsaasCheckoutPayment,
  type AsaasSandboxSubscriptionClient,
} from "./asaas-subscription-client";
import { addOneCalendarMonth, saoPauloToday } from "./billing";
import { getDb } from "./db";
import { sendSubscriptionCancellationEmail } from "./mailer";
import { recoverPaidCheckoutWithOutcome, SubscriptionLifecycleError } from "./subscription-lifecycle";

type PaymentEvent = "PAYMENT_CONFIRMED" | "PAYMENT_RECEIVED" | "PAYMENT_OVERDUE" |
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED" | "PAYMENT_REFUNDED" | "PAYMENT_CHARGEBACK_REQUESTED";
type PaymentState = "overdue" | "confirmed" | "refunded" | "chargeback";
const MAX_EARLY_RENEWAL_DAYS = 45;

interface Payload {
  id: string;
  event: PaymentEvent;
  accountId: string;
  payment: {
    id: string;
    subscriptionId?: string;
    checkoutSession?: string;
    billingType: string;
    value: number;
    dueDate?: string;
    invoiceUrl?: string;
    status?: string;
  };
}

interface Order {
  id: string;
  user_id: string;
  checkout_id: string | null;
  subscription_id: string | null;
  initial_payment_id: string | null;
  period_end: Date | null;
  amount_cents: number;
  currency: string;
  status: string;
  method: "card" | "pix";
}

export class SubscriptionPaymentWebhookError extends Error {
  constructor(readonly code: "INVALID" | "RETRY", message: string) { super(message); }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function isSubscriptionPaymentEvent(value: unknown): boolean {
  return value !== null && typeof value === "object" &&
    typeof (value as Record<string, unknown>).event === "string" &&
    (value as Record<string, string>).event.startsWith("PAYMENT_");
}

export function isSubscriptionEvent(value: unknown): boolean {
  return value !== null && typeof value === "object" &&
    typeof (value as Record<string, unknown>).event === "string" &&
    (value as Record<string, string>).event.startsWith("SUBSCRIPTION_");
}

export async function processSubscriptionWebhook(value: unknown): Promise<{
  duplicate: boolean; granted: boolean; outcome: string;
}> {
  if (!value || typeof value !== "object") throw new SubscriptionPaymentWebhookError("INVALID", "Evento inválido.");
  const event = value as Record<string, unknown>;
  if (event.event !== "SUBSCRIPTION_DELETED") {
    return { duplicate: false, granted: false, outcome: "ignored_event" };
  }
  const account = event.account as Record<string, unknown> | undefined;
  const subscription = event.subscription as Record<string, unknown> | undefined;
  if (!validId(event.id) || !account || account.id !== process.env.ASAAS_SANDBOX_ACCOUNT_ID ||
    !subscription || !validId(subscription.id)) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Evento de assinatura inválido.");
  }
  const client = await getDb().connect();
  let email: { recipient: string; paidUntil: Date } | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.access_actor', 'subscription_webhook', TRUE), set_config('app.access_reason', 'verified_subscription_event', TRUE)");
    const discovered = await client.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM billing_order WHERE subscription_id = $1 AND method = 'card'",
      [subscription.id],
    );
    if (!discovered.rows[0]) {
      throw new SubscriptionPaymentWebhookError("RETRY", "Assinatura ainda não conciliada.");
    }
    await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [discovered.rows[0].user_id]);
    const inserted = await client.query(`
      INSERT INTO billing_subscription_event (event_id, subscription_id, event_type, outcome)
      VALUES ($1, $2, $3, 'received') ON CONFLICT (event_id) DO NOTHING RETURNING event_id
    `, [event.id, subscription.id, event.event]);
    if (!inserted.rows[0]) {
      await client.query("COMMIT");
      return { duplicate: true, granted: false, outcome: "duplicate" };
    }
    const updated = await client.query<{ email: string; period_end: Date }>(`
      UPDATE billing_order b SET cancellation_state = 'confirmed',
        cancellation_confirmed_at = NOW(), updated_at = NOW()
      FROM "user" u WHERE b.id = $1 AND b.user_id = u.id
        AND b.subscription_id = $2 AND b.cancellation_state <> 'confirmed'
      RETURNING u.email, b.period_end
    `, [discovered.rows[0].id, subscription.id]);
    if (updated.rows[0]?.period_end) {
      const entitlement = await client.query<{ expires_at: Date | null }>(
        "SELECT expires_at FROM account_entitlement WHERE user_id = $1", [discovered.rows[0].user_id],
      );
      email = { recipient: updated.rows[0].email,
        paidUntil: entitlement.rows[0]?.expires_at ?? updated.rows[0].period_end };
    }
    await client.query("UPDATE billing_subscription_event SET outcome = 'confirmed' WHERE event_id = $1", [event.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (email) {
    try { await sendSubscriptionCancellationEmail(email.recipient, email.paidUntil); }
    catch { /* Provider state remains authoritative if email fails. */ }
  }
  return { duplicate: false, granted: false, outcome: "confirmed" };
}

function parse(value: unknown): Payload | null {
  if (!value || typeof value !== "object") throw new SubscriptionPaymentWebhookError("INVALID", "Evento inválido.");
  const source = value as Record<string, unknown>;
  const supported: PaymentEvent[] = [
    "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE",
    "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED",
  ];
  if (typeof source.event !== "string" || !supported.includes(source.event as PaymentEvent)) return null;
  const account = source.account as Record<string, unknown> | undefined;
  const payment = source.payment as Record<string, unknown> | undefined;
  if (!validId(source.id) || !account || !validId(account.id) || !payment ||
    !validId(payment.id) ||
    typeof payment.billingType !== "string" ||
    typeof payment.value !== "number" || !Number.isFinite(payment.value)) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Dados financeiros do evento inválidos.");
  }
  if (payment.subscription !== undefined && payment.subscription !== null && !validId(payment.subscription)) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Assinatura da cobrança inválida.");
  }
  const dueDate = payment.dueDate;
  if (dueDate !== undefined && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Data da cobrança inválida.");
  }
  const originalDueDate = payment.originalDueDate;
  if (originalDueDate !== undefined && originalDueDate !== null &&
    (typeof originalDueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(originalDueDate))) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Data original da cobrança inválida.");
  }
  // Forcing OVERDUE in Sandbox moves dueDate; originalDueDate keeps the paid cycle's anchor.
  const cycleDueDate = typeof originalDueDate === "string" ? originalDueDate :
    typeof dueDate === "string" ? dueDate : undefined;
  if (payment.checkoutSession !== undefined && !validId(payment.checkoutSession)) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Checkout da cobrança inválido.");
  }
  const invoiceUrl = payment.invoiceUrl;
  if (invoiceUrl !== undefined && typeof invoiceUrl !== "string") {
    throw new SubscriptionPaymentWebhookError("INVALID", "Fatura da cobrança inválida.");
  }
  let safeInvoiceUrl: string | undefined;
  if (invoiceUrl) {
    try {
      const url = new URL(invoiceUrl);
      if (url.origin === "https://sandbox.asaas.com" && url.pathname.startsWith("/i/") &&
        !url.username && !url.password) safeInvoiceUrl = url.toString();
    } catch { /* Invalid provider URL is omitted from the account page. */ }
  }
  return {
    id: source.id,
    event: source.event as PaymentEvent,
    accountId: account.id,
    payment: {
      id: payment.id,
      ...(typeof payment.subscription === "string" ? { subscriptionId: payment.subscription } : {}),
      ...(cycleDueDate ? { dueDate: cycleDueDate } : {}),
      ...(safeInvoiceUrl ? { invoiceUrl: safeInvoiceUrl } : {}),
      ...(typeof payment.checkoutSession === "string" ? { checkoutSession: payment.checkoutSession } : {}),
      ...(typeof payment.status === "string" ? { status: payment.status } : {}),
      billingType: payment.billingType, value: payment.value,
    },
  };
}

function dueDateEnd(dueDate: string): Date {
  const date = new Date(`${dueDate}T15:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Data da cobrança inválida.");
  }
  const maxDueDate = new Date(`${saoPauloToday()}T12:00:00.000Z`);
  maxDueDate.setUTCDate(maxDueDate.getUTCDate() + MAX_EARLY_RENEWAL_DAYS);
  if (dueDate > maxDueDate.toISOString().slice(0, 10)) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Cobrança futura fora do período permitido.");
  }
  return addOneCalendarMonth(date);
}

async function recalculateEntitlement(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query<{ paid_until: Date | null }>(`
    SELECT MAX(period_end) AS paid_until FROM (
      SELECT period_end FROM billing_payment_cycle
      WHERE user_id = $1 AND state = 'confirmed'
      UNION ALL
      SELECT b.period_end FROM billing_order b
      WHERE b.user_id = $1 AND b.status = 'paid' AND b.period_end IS NOT NULL
        AND b.initial_payment_id IS NULL
    ) valid_periods
  `, [userId]);
  const paidUntil = result.rows[0]?.paid_until ?? null;
  await client.query(`
    INSERT INTO account_entitlement (user_id, plan, expires_at, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan,
      expires_at = EXCLUDED.expires_at, updated_at = NOW()
  `, [userId, paidUntil && paidUntil.getTime() > Date.now() ? "pro" : "free", paidUntil]);
}

async function rejectCorrelation(payload: Payload): Promise<{
  duplicate: boolean; granted: boolean; outcome: string;
}> {
  const inserted = await getDb().query(`
    INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
    VALUES ($1, $2, $3, 'rejected_correlation')
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id
  `, [payload.id, payload.payment.id, payload.event]);
  return { duplicate: !inserted.rows[0], granted: false, outcome: "rejected_correlation" };
}

export async function processSubscriptionPaymentWebhook(
  value: unknown,
  provider?: AsaasSandboxSubscriptionClient,
): Promise<{
  duplicate: boolean; granted: boolean; outcome: string;
}> {
  const payload = parse(value);
  if (!payload) return { duplicate: false, granted: false, outcome: "ignored_event" };
  if (payload.accountId !== process.env.ASAAS_SANDBOX_ACCOUNT_ID) {
    throw new SubscriptionPaymentWebhookError("INVALID", "Evento de outra conta Asaas.");
  }
  const linkedHint = await getDb().query<{ id: string }>(`
    SELECT id FROM billing_order
    WHERE checkout_id = $1 OR subscription_id = $2 OR initial_payment_id = $3
    LIMIT 2
  `, [payload.payment.checkoutSession ?? null, payload.payment.subscriptionId ?? null, payload.payment.id]);
  const hasLocalReference = linkedHint.rows.length > 0;
  if (!["CREDIT_CARD", "PIX"].includes(payload.payment.billingType) ||
    Math.round(payload.payment.value * 100) !== 2990) {
    if (!hasLocalReference) return { duplicate: false, granted: false, outcome: "ignored_external" };
    throw new SubscriptionPaymentWebhookError("INVALID", "Cobrança vinculada não corresponde ao plano.");
  }
  if (payload.payment.billingType === "CREDIT_CARD" && payload.payment.checkoutSession) {
    const unlinked = await getDb().query<{ id: string }>(`
      SELECT id FROM billing_order
      WHERE checkout_id = $1 AND method = 'card' AND status = 'paid'
        AND (subscription_id IS NULL OR initial_payment_id IS NULL)
      LIMIT 2
    `, [payload.payment.checkoutSession]);
    if (unlinked.rows.length > 1) {
      throw new SubscriptionPaymentWebhookError("INVALID", "Checkout associado a mais de um pedido.");
    }
    if (unlinked.rows[0]) {
      let verified: AsaasCheckoutPayment | undefined;
      try {
        verified = await (provider ?? createAsaasSandboxSubscriptionClient())
          .findCheckoutPaymentBySession(payload.payment.checkoutSession);
      } catch {
        throw new SubscriptionPaymentWebhookError("RETRY", "Primeira cobrança aguarda consulta ao Asaas.");
      }
      if (!verified) {
        throw new SubscriptionPaymentWebhookError("RETRY", "Primeira cobrança ainda não aparece no Asaas.");
      }
      if (verified.checkoutSession !== payload.payment.checkoutSession ||
        verified.paymentId !== payload.payment.id ||
        verified.subscriptionId !== payload.payment.subscriptionId ||
        verified.billingType !== "CREDIT_CARD" ||
        Math.round((verified.value ?? 0) * 100) !== 2990) {
        return rejectCorrelation(payload);
      }
      if (["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(payload.event) &&
        !["CONFIRMED", "RECEIVED"].includes(verified.paymentStatus ?? "")) {
        throw new SubscriptionPaymentWebhookError("RETRY", "Confirmação financeira ainda não aparece no Asaas.");
      }
    }
  }
  let initialCandidate: AsaasCheckoutPayment | undefined;
  if (payload.payment.subscriptionId && !payload.payment.checkoutSession) {
    const linked = await getDb().query<{ checkout_id: string; initial_payment_id: string | null }>(`
      SELECT checkout_id, initial_payment_id FROM billing_order
      WHERE subscription_id = $1 AND method = 'card' AND status = 'paid'
      LIMIT 1
    `, [payload.payment.subscriptionId]);
    if (!linked.rows[0]?.initial_payment_id) {
      const unlinked = linked.rows[0] ? true : Boolean((await getDb().query(`
        SELECT id FROM billing_order WHERE method = 'card' AND status = 'paid'
          AND subscription_id IS NULL AND checkout_id IS NOT NULL LIMIT 1
      `)).rows[0]);
      if (unlinked) {
        const api = provider ?? createAsaasSandboxSubscriptionClient();
        let found: AsaasCheckoutPayment | undefined;
        try {
          found = linked.rows[0]
            ? await api.findCheckoutPaymentBySession(linked.rows[0].checkout_id)
            : await api.findInitialPaymentBySubscription(payload.payment.subscriptionId);
        } catch (error) {
          if (linked.rows[0]) throw error;
        }
        const localCheckout = found && (await getDb().query<{ id: string }>(
          "SELECT id FROM billing_order WHERE checkout_id = $1 LIMIT 1", [found.checkoutSession],
        )).rows[0];
        if (linked.rows[0] || localCheckout) {
          if (!found || found.subscriptionId !== payload.payment.subscriptionId ||
            (linked.rows[0] && found.checkoutSession !== linked.rows[0].checkout_id) ||
            found.billingType !== "CREDIT_CARD" ||
            Math.round((found.value ?? 0) * 100) !== 2990 ||
            !["CONFIRMED", "RECEIVED", "REFUNDED", "CHARGEBACK_REQUESTED"].includes(found.paymentStatus ?? "")) {
            throw new SubscriptionPaymentWebhookError("RETRY", "Primeira cobrança ainda sem conciliação segura.");
          }
          initialCandidate = found;
        }
      }
    }
  }
  let recoveredCheckout = false;
  let duplicateFinancial = false;
  const checkoutSession = payload.payment.checkoutSession ?? initialCandidate?.checkoutSession;
  if (["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(payload.event) && checkoutSession) {
    const pending = await getDb().query<{ user_id: string; method: "card" | "pix" }>(`
      SELECT user_id, method FROM billing_order
      WHERE checkout_id = $1 AND status IN ('creating', 'checkout_created', 'failed')
      LIMIT 2
    `, [checkoutSession]);
    if (pending.rows.length > 1) {
      throw new SubscriptionPaymentWebhookError("INVALID", "Checkout associado a mais de um pedido.");
    }
    const order = pending.rows[0];
    if (order) {
      const methodMatches = order.method === "card"
        ? payload.payment.billingType === "CREDIT_CARD" && Boolean(payload.payment.subscriptionId)
        : payload.payment.billingType === "PIX" && !payload.payment.subscriptionId;
      if (!methodMatches || (payload.payment.status &&
        !["CONFIRMED", "RECEIVED"].includes(payload.payment.status))) {
        throw new SubscriptionPaymentWebhookError("INVALID", "Cobrança não corresponde ao checkout pendente.");
      }
      try {
        const recovery = await recoverPaidCheckoutWithOutcome(
          order.user_id,
          provider ?? createAsaasSandboxSubscriptionClient(),
          checkoutSession,
          { paymentId: payload.payment.id, subscriptionId: payload.payment.subscriptionId },
        );
        recoveredCheckout = recovery.granted;
        duplicateFinancial = recovery.newlyPaid && !recovery.granted;
      } catch (error) {
        if (error instanceof SubscriptionLifecycleError && error.code === "RECONCILIATION_INVALID") {
          return rejectCorrelation(payload);
        }
        throw new SubscriptionPaymentWebhookError("RETRY", "Pagamento inicial aguarda conciliação no Asaas.");
      }
    }
  }
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.access_actor', 'payment_webhook', TRUE), set_config('app.access_reason', 'verified_payment_event', TRUE)");
    const lookup = await client.query<Order>(`
      SELECT id, user_id, checkout_id, subscription_id, initial_payment_id,
        period_end, amount_cents, currency, status, method
      FROM billing_order WHERE status = 'paid' AND
        (subscription_id = $1 OR checkout_id = $2 OR initial_payment_id = $3)
      ORDER BY paid_at DESC LIMIT 2
    `, [payload.payment.subscriptionId ?? null,
      payload.payment.checkoutSession ?? initialCandidate?.checkoutSession ?? null, payload.payment.id]);
    if (lookup.rows.length !== 1) {
      if (lookup.rows.length === 0 && !hasLocalReference && !initialCandidate) {
        await client.query("COMMIT");
        return { duplicate: false, granted: false, outcome: "ignored_external" };
      }
      if (["PAYMENT_OVERDUE", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"].includes(payload.event) &&
        lookup.rows.length === 0) {
        await client.query("COMMIT");
        return { duplicate: false, granted: false, outcome: "unmatched_unpaid" };
      }
      throw new SubscriptionPaymentWebhookError("RETRY", "Cobrança ainda sem correlação com pedido pago.");
    }
    const discovered = lookup.rows[0];
    await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [discovered.user_id]);
    const locked = await client.query<Order>(`
      SELECT id, user_id, checkout_id, subscription_id, initial_payment_id,
        period_end, amount_cents, currency, status, method
      FROM billing_order WHERE id = $1 FOR UPDATE
    `, [discovered.id]);
    const order = locked.rows[0];
    const validCard = order?.method === "card" && payload.payment.billingType === "CREDIT_CARD" &&
      Boolean(payload.payment.subscriptionId) &&
      (!order.subscription_id || order.subscription_id === payload.payment.subscriptionId) &&
      (Boolean(order.subscription_id) || order.checkout_id ===
        (payload.payment.checkoutSession ?? initialCandidate?.checkoutSession));
    const validPix = order?.method === "pix" && payload.payment.billingType === "PIX" &&
      !payload.payment.subscriptionId &&
      (order.checkout_id === payload.payment.checkoutSession || order.initial_payment_id === payload.payment.id);
    if (!order || order.status !== "paid" || order.currency !== "BRL" || order.amount_cents !== 2990 ||
      !(validCard || validPix)) {
      throw new SubscriptionPaymentWebhookError("INVALID", "Cobrança não corresponde ao pedido.");
    }

    const inserted = await client.query(`
      INSERT INTO billing_payment_event (event_id, payment_id, event_type, outcome)
      VALUES ($1, $2, $3, 'received') ON CONFLICT (event_id) DO NOTHING RETURNING event_id
    `, [payload.id, payload.payment.id, payload.event]);
    if (!inserted.rows[0]) {
      await client.query("COMMIT");
      return { duplicate: true, granted: false, outcome: "duplicate" };
    }

    if (order.method === "card" && !order.initial_payment_id && initialCandidate && order.period_end) {
      if (order.checkout_id !== initialCandidate.checkoutSession) {
        throw new SubscriptionPaymentWebhookError("INVALID", "Checkout inicial mudou durante a conciliação.");
      }
      const initialState: PaymentState = initialCandidate.paymentStatus === "REFUNDED" ? "refunded" :
        initialCandidate.paymentStatus === "CHARGEBACK_REQUESTED" ? "chargeback" : "confirmed";
      await client.query(`
        UPDATE billing_order SET initial_payment_id = $2,
          subscription_id = COALESCE(subscription_id, $3),
          subscription_reconciled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND initial_payment_id IS NULL
      `, [order.id, initialCandidate.paymentId, payload.payment.subscriptionId]);
      await client.query(`
        INSERT INTO billing_payment_cycle (payment_id, order_id, user_id,
          subscription_id, due_date, period_end, state, is_initial)
        VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
        ON CONFLICT (payment_id) DO NOTHING
      `, [initialCandidate.paymentId, order.id, order.user_id,
        payload.payment.subscriptionId, initialCandidate.dueDate ?? null,
        order.period_end, initialState]);
      order.initial_payment_id = initialCandidate.paymentId;
      order.subscription_id = payload.payment.subscriptionId!;
    }

    const isInitial = order.method === "pix" || order.initial_payment_id === payload.payment.id ||
      (!order.initial_payment_id && order.checkout_id ===
        (payload.payment.checkoutSession ?? initialCandidate?.checkoutSession));
    if (order.method === "card" && !order.subscription_id && !isInitial) {
      throw new SubscriptionPaymentWebhookError("RETRY", "Assinatura ainda sem vínculo seguro.");
    }
    if (order.method === "card" && order.subscription_id && !order.initial_payment_id && !isInitial) {
      throw new SubscriptionPaymentWebhookError("RETRY", "Primeira cobrança ainda sem conciliação.");
    }
    if (isInitial && !order.period_end) {
      await client.query(`
        UPDATE billing_order SET subscription_id = COALESCE(subscription_id, $2),
          initial_payment_id = COALESCE(initial_payment_id, $3), updated_at = NOW()
        WHERE id = $1
      `, [order.id, payload.payment.subscriptionId ?? null, payload.payment.id]);
      await client.query("UPDATE billing_payment_event SET outcome = 'paid_without_entitlement' WHERE event_id = $1", [payload.id]);
      await client.query("COMMIT");
      return { duplicate: false, granted: false, outcome: "paid_without_entitlement" };
    }
    if (isInitial && ["PAYMENT_OVERDUE", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"].includes(payload.event)) {
      await client.query("UPDATE billing_payment_event SET outcome = 'ignored_old_failure' WHERE event_id = $1", [payload.id]);
      await client.query("COMMIT");
      return { duplicate: false, granted: false, outcome: "ignored_old_failure" };
    }
    if (!isInitial && !payload.payment.dueDate) {
      throw new SubscriptionPaymentWebhookError("INVALID", "Renovação sem vencimento.");
    }
    const previous = await client.query<{
      state: PaymentState; period_end: Date; order_id: string; user_id: string; subscription_id: string;
    }>(
      "SELECT state, period_end, order_id, user_id, subscription_id FROM billing_payment_cycle WHERE payment_id = $1 FOR UPDATE",
      [payload.payment.id],
    );
    if (previous.rows[0] && (previous.rows[0].order_id !== order.id ||
      previous.rows[0].user_id !== order.user_id ||
      previous.rows[0].subscription_id !== (payload.payment.subscriptionId ?? null))) {
      throw new SubscriptionPaymentWebhookError("INVALID", "Identificador financeiro já associado a outra compra.");
    }
    const oldState = previous.rows[0]?.state;
    const newState: PaymentState = payload.event === "PAYMENT_REFUNDED" ? "refunded" :
      payload.event === "PAYMENT_CHARGEBACK_REQUESTED" ? "chargeback" :
      ["PAYMENT_OVERDUE", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"].includes(payload.event) ? "overdue" : "confirmed";
    if (newState === "confirmed" && payload.payment.status &&
      !["CONFIRMED", "RECEIVED"].includes(payload.payment.status)) {
      throw new SubscriptionPaymentWebhookError("INVALID", "Pagamento sem confirmação financeira.");
    }
    const state = oldState === "refunded" || oldState === "chargeback" ? oldState :
      oldState === "confirmed" && newState === "overdue" ? oldState : newState;
    const periodEnd = isInitial ? new Date(order.period_end!) :
      oldState === "overdue" ? dueDateEnd(payload.payment.dueDate!) :
        previous.rows[0]?.period_end ?? dueDateEnd(payload.payment.dueDate!);

    if (isInitial && !order.initial_payment_id) {
      await client.query(`
        UPDATE billing_order SET subscription_id = COALESCE(subscription_id, $2), initial_payment_id = $3,
          subscription_reconciled_at = NOW(), updated_at = NOW() WHERE id = $1
      `, [order.id, payload.payment.subscriptionId ?? null, payload.payment.id]);
    }
    await client.query(`
      INSERT INTO billing_payment_cycle (payment_id, order_id, user_id, subscription_id,
        due_date, invoice_url, period_end, state, is_initial)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (payment_id) DO UPDATE SET state = EXCLUDED.state,
        due_date = CASE WHEN billing_payment_cycle.state = 'overdue'
          THEN COALESCE(EXCLUDED.due_date, billing_payment_cycle.due_date)
          ELSE billing_payment_cycle.due_date END,
        period_end = CASE WHEN billing_payment_cycle.state = 'overdue'
          THEN EXCLUDED.period_end ELSE billing_payment_cycle.period_end END,
        invoice_url = COALESCE(EXCLUDED.invoice_url, billing_payment_cycle.invoice_url), updated_at = NOW()
    `, [payload.payment.id, order.id, order.user_id, payload.payment.subscriptionId ?? null,
      payload.payment.dueDate ?? null, payload.payment.invoiceUrl ?? null, periodEnd, state, isInitial]);
    await recalculateEntitlement(client, order.user_id);
    const outcome = duplicateFinancial ? "paid_duplicate_financial" : state;
    await client.query("UPDATE billing_payment_event SET outcome = $2 WHERE event_id = $1", [payload.id, outcome]);
    await client.query("COMMIT");
    return { duplicate: false, granted: state === "confirmed" &&
      (recoveredCheckout || (oldState !== "confirmed" && !isInitial)),
      outcome };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
