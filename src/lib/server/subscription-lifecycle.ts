import type { PoolClient } from "pg";

import {
  createAsaasSandboxSubscriptionClient,
  AsaasSubscriptionClientError,
  type AsaasSubscriptionPayment,
  type AsaasCheckoutPayment,
  type AsaasSandboxSubscriptionClient,
} from "./asaas-subscription-client";
import { addOneCalendarMonth, getBillingStatus, type BillingStatus } from "./billing";
import { getDb } from "./db";
import { sendSubscriptionCancellationEmail } from "./mailer";

type CancellationState = "not_requested" | "requested" | "unknown" | "confirmed";

interface SubscriptionOrder {
  id: string;
  checkout_id: string | null;
  subscription_id: string | null;
  initial_payment_id: string | null;
  cancellation_state: CancellationState;
  period_end: Date | null;
  amount_cents: number;
  currency: string;
  email: string;
  status?: string;
  method?: "card" | "pix";
}

export class SubscriptionLifecycleError extends Error {
  constructor(
    readonly code: "NO_PAID_CARD_ORDER" | "RECONCILIATION_UNAVAILABLE" |
      "RECONCILIATION_INVALID" | "CANCELLATION_PENDING" | "CANCELLATION_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.access_actor', 'billing_reconciliation', TRUE), set_config('app.access_reason', 'verified_provider_state', TRUE)");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function paidCardOrder(client: PoolClient, userId: string, lock = false): Promise<SubscriptionOrder | undefined> {
  const user = await client.query('SELECT id FROM "user" WHERE id = $1' + (lock ? " FOR UPDATE" : ""), [userId]);
  if (!user.rows[0]) return undefined;
  const result = await client.query<SubscriptionOrder>(`
    SELECT b.id, b.checkout_id, b.subscription_id, b.initial_payment_id,
      b.cancellation_state, b.period_end, b.amount_cents, b.currency, u.email
    FROM billing_order b JOIN "user" u ON u.id = b.user_id
    WHERE b.user_id = $1 AND b.method = 'card' AND b.status = 'paid'
    ORDER BY b.paid_at DESC, b.created_at DESC
    LIMIT 1${lock ? " FOR UPDATE OF b" : ""}
  `, [userId]);
  return result.rows[0];
}

async function readPaidCardOrder(userId: string): Promise<SubscriptionOrder> {
  const client = await getDb().connect();
  try {
    const order = await paidCardOrder(client, userId);
    if (!order) throw new SubscriptionLifecycleError("NO_PAID_CARD_ORDER", "Não há assinatura de cartão paga nesta conta.");
    return order;
  } finally {
    client.release();
  }
}

async function verifiedCheckoutPayment(
  order: SubscriptionOrder,
  provider: AsaasSandboxSubscriptionClient,
): Promise<AsaasSubscriptionPayment> {
  if (!order.checkout_id || order.currency !== "BRL" || order.amount_cents !== 2990) {
    throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "O pedido não pode ser conciliado com segurança.");
  }
  const payment = await provider.findSubscriptionByCheckoutSession(order.checkout_id);
  if (!payment) {
    throw new SubscriptionLifecycleError("RECONCILIATION_UNAVAILABLE", "A cobrança ainda não foi encontrada no Asaas. Tente novamente mais tarde.");
  }
  if (payment.checkoutSession !== order.checkout_id ||
    payment.billingType !== "CREDIT_CARD" ||
    Math.round((payment.value ?? 0) * 100) !== order.amount_cents ||
    (payment.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(payment.dueDate))) {
    throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "A cobrança encontrada não corresponde ao pedido pago.");
  }
  if (!["CONFIRMED", "RECEIVED"].includes(payment.paymentStatus ?? "")) {
    throw new SubscriptionLifecycleError("RECONCILIATION_UNAVAILABLE", "A confirmação financeira ainda não aparece na consulta ao Asaas.");
  }
  const subscription = await provider.getSubscription(payment.subscriptionId);
  if (subscription.id !== payment.subscriptionId || subscription.deleted === true ||
    subscription.cycle !== "MONTHLY" ||
    subscription.billingType !== "CREDIT_CARD" ||
    Math.round((subscription.value ?? 0) * 100) !== order.amount_cents) {
    throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "A assinatura encontrada não corresponde ao plano pago.");
  }
  if (subscription.status !== "ACTIVE") {
    throw new SubscriptionLifecycleError("RECONCILIATION_UNAVAILABLE", "A assinatura ainda não está ativa na consulta ao Asaas.");
  }
  return payment;
}

export async function reconcileCardSubscription(
  userId: string,
  provider: AsaasSandboxSubscriptionClient = createAsaasSandboxSubscriptionClient(),
): Promise<BillingStatus> {
  const order = await readPaidCardOrder(userId);
  if (order.subscription_id && order.initial_payment_id) return getBillingStatus(userId);
  const payment = await verifiedCheckoutPayment(order, provider);
  if (!order.period_end) {
    throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "O período da cobrança não pode ser confirmado.");
  }

  await transaction(async (client) => {
    const current = await paidCardOrder(client, userId, true);
    if (!current || current.id !== order.id || current.checkout_id !== payment.checkoutSession ||
      current.amount_cents !== order.amount_cents || current.currency !== "BRL" ||
      (current.subscription_id && current.subscription_id !== payment.subscriptionId) ||
      (current.initial_payment_id && current.initial_payment_id !== payment.paymentId)) {
      throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "O pedido mudou durante a conciliação.");
    }
    await client.query(`
      UPDATE billing_order SET subscription_id = $2, initial_payment_id = $3,
        subscription_reconciled_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [order.id, payment.subscriptionId, payment.paymentId]);
    await client.query(`
      INSERT INTO billing_payment_cycle (payment_id, order_id, user_id, subscription_id,
        due_date, period_end, state, is_initial)
      VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', TRUE)
      ON CONFLICT (payment_id) DO NOTHING
    `, [payment.paymentId, order.id, userId, payment.subscriptionId, payment.dueDate ?? null, current.period_end]);
  });
  return getBillingStatus(userId);
}

export async function recoverPaidCheckoutWithOutcome(
  userId: string,
  provider: AsaasSandboxSubscriptionClient = createAsaasSandboxSubscriptionClient(),
  expectedCheckoutSession?: string,
  expectedPayment?: { paymentId: string; subscriptionId?: string },
): Promise<{ status: BillingStatus; granted: boolean; newlyPaid: boolean }> {
  const pending = await getDb().query<SubscriptionOrder>(`
    SELECT b.id, b.checkout_id, b.subscription_id, b.initial_payment_id,
      b.cancellation_state, b.period_end, b.amount_cents, b.currency,
      b.status, b.method, u.email
    FROM billing_order b JOIN "user" u ON u.id = b.user_id
    WHERE b.user_id = $1 AND b.method IN ('card', 'pix')
      AND b.status IN ('creating', 'checkout_created', 'failed')
      AND b.checkout_id IS NOT NULL
      AND ($2::text IS NULL OR b.checkout_id = $2)
    ORDER BY b.created_at DESC LIMIT 1
  `, [userId, expectedCheckoutSession ?? null]);
  const order = pending.rows[0];
  if (!order) {
    throw new SubscriptionLifecycleError("RECONCILIATION_UNAVAILABLE", "Não há checkout para verificar.");
  }
  let payment: AsaasCheckoutPayment;
  if (order.method === "card") {
    payment = await verifiedCheckoutPayment(order, provider);
  } else {
    const found = await provider.findCheckoutPaymentBySession(order.checkout_id!);
    if (!found) {
      throw new SubscriptionLifecycleError("RECONCILIATION_UNAVAILABLE", "A cobrança ainda não foi encontrada no Asaas.");
    }
    if (found.checkoutSession !== order.checkout_id || found.subscriptionId ||
      found.billingType !== "PIX" ||
      Math.round((found.value ?? 0) * 100) !== order.amount_cents ||
      order.currency !== "BRL" || order.amount_cents !== 2990) {
      throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "A cobrança Pix não corresponde ao checkout.");
    }
    if (found.paymentStatus !== "RECEIVED") {
      throw new SubscriptionLifecycleError("RECONCILIATION_UNAVAILABLE", "O Pix ainda não aparece como recebido no Asaas.");
    }
    payment = found;
  }
  if (expectedPayment && (payment.paymentId !== expectedPayment.paymentId ||
    (payment.subscriptionId ?? null) !== (expectedPayment.subscriptionId ?? null))) {
    throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "O evento não corresponde à cobrança inicial do checkout.");
  }
  const recovery = await transaction(async (client) => {
    await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [userId]);
    const currentResult = await client.query<SubscriptionOrder>(`
      SELECT id, checkout_id, subscription_id, initial_payment_id,
        cancellation_state, period_end, amount_cents, currency, status, method
      FROM billing_order WHERE id = $1 AND user_id = $2 FOR UPDATE
    `, [order.id, userId]);
    const current = currentResult.rows[0];
    if (!current || current.checkout_id !== payment.checkoutSession ||
      current.amount_cents !== 2990 || current.currency !== "BRL" || current.method !== order.method) {
      throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "O checkout mudou durante a verificação.");
    }
    if (current.status === "paid") return { granted: false, newlyPaid: false };
    if (!["creating", "checkout_created", "failed"].includes(current.status ?? "")) {
      throw new SubscriptionLifecycleError("RECONCILIATION_INVALID", "O checkout não está em estado conciliável.");
    }
    const entitlement = await client.query<{ expires_at: Date | null }>(
      "SELECT expires_at FROM account_entitlement WHERE user_id = $1", [userId],
    );
    const now = new Date();
    const activeUntil = entitlement.rows[0]?.expires_at;
    const periodEnd = activeUntil && new Date(activeUntil).getTime() > now.getTime()
      ? new Date(activeUntil) : addOneCalendarMonth(now);
    await client.query(`
      UPDATE billing_order SET status = 'paid', provider_status = 'PAID',
        subscription_id = $2, initial_payment_id = $3,
        subscription_reconciled_at = NOW(), period_start = $4,
        period_end = $5, paid_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [order.id, payment.subscriptionId ?? null, payment.paymentId, now, periodEnd]);
    await client.query(`
      INSERT INTO billing_payment_cycle (payment_id, order_id, user_id, subscription_id,
        due_date, period_end, state, is_initial)
      VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', TRUE)
    `, [payment.paymentId, order.id, userId, payment.subscriptionId ?? null, payment.dueDate ?? null, periodEnd]);
    if (!activeUntil || new Date(activeUntil).getTime() <= now.getTime()) {
      await client.query(`
        INSERT INTO account_entitlement (user_id, plan, expires_at, updated_at)
        VALUES ($1, 'pro', $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET plan = 'pro',
          expires_at = EXCLUDED.expires_at, updated_at = NOW()
      `, [userId, periodEnd]);
      return { granted: true, newlyPaid: true };
    }
    return { granted: false, newlyPaid: true };
  });
  return { status: await getBillingStatus(userId), ...recovery };
}

export async function recoverPaidCheckout(
  userId: string,
  provider: AsaasSandboxSubscriptionClient = createAsaasSandboxSubscriptionClient(),
  expectedCheckoutSession?: string,
): Promise<BillingStatus> {
  const result = await recoverPaidCheckoutWithOutcome(userId, provider, expectedCheckoutSession);
  return result.status;
}

export async function cancelCardSubscription(
  userId: string,
  provider: AsaasSandboxSubscriptionClient = createAsaasSandboxSubscriptionClient(),
): Promise<BillingStatus> {
  const order = await transaction(async (client) => {
    const current = await paidCardOrder(client, userId, true);
    if (!current) throw new SubscriptionLifecycleError("NO_PAID_CARD_ORDER", "Não há assinatura de cartão paga nesta conta.");
    if (!current.subscription_id || !current.period_end) {
      throw new SubscriptionLifecycleError("CANCELLATION_UNAVAILABLE", "Concilie a assinatura antes de cancelar a renovação.");
    }
    if (current.cancellation_state === "confirmed") return current;
    if (current.cancellation_state !== "not_requested") {
      throw new SubscriptionLifecycleError("CANCELLATION_PENDING", "O cancelamento está em verificação. Nenhuma nova tentativa será feita automaticamente.");
    }
    await client.query(`
      UPDATE billing_order SET cancellation_state = 'requested',
        cancellation_requested_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [current.id]);
    return current;
  });
  if (order.cancellation_state === "confirmed") return getBillingStatus(userId);

  try {
    const result = await provider.cancelSubscription(order.subscription_id!);
    if (result.id !== order.subscription_id || result.cancelled !== true) {
      throw new Error("Unexpected cancellation response");
    }
  } catch {
    await getDb().query(`
      UPDATE billing_order SET cancellation_state = 'unknown', updated_at = NOW()
      WHERE id = $1 AND cancellation_state = 'requested'
    `, [order.id]);
    const status = await getBillingStatus(userId);
    if (status.subscription?.cancellationState === "confirmed") return status;
    throw new SubscriptionLifecycleError("CANCELLATION_PENDING", "O Asaas não confirmou o cancelamento. Verifique o estado antes de tentar novamente.");
  }

  const confirmed = await getDb().query(`
    UPDATE billing_order SET cancellation_state = 'confirmed',
      cancellation_confirmed_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND cancellation_state IN ('requested', 'unknown')
  `, [order.id]);
  const status = await getBillingStatus(userId);
  if (confirmed.rowCount) {
    try {
      await sendSubscriptionCancellationEmail(order.email, new Date(status.paidUntil ?? order.period_end!));
    } catch {
      // The provider cancellation is final even when email delivery fails.
    }
  }
  return status;
}

export async function verifyCardCancellation(
  userId: string,
  provider: AsaasSandboxSubscriptionClient = createAsaasSandboxSubscriptionClient(),
): Promise<BillingStatus> {
  const order = await readPaidCardOrder(userId);
  if (order.cancellation_state === "confirmed") return getBillingStatus(userId);
  if (!order.subscription_id || !["requested", "unknown"].includes(order.cancellation_state)) {
    throw new SubscriptionLifecycleError("CANCELLATION_UNAVAILABLE", "Não há cancelamento pendente de verificação.");
  }
  let deleted = false;
  try {
    const subscription = await provider.getSubscription(order.subscription_id);
    deleted = subscription.id === order.subscription_id && subscription.deleted === true;
  } catch (error) {
    if (!(error instanceof AsaasSubscriptionClientError) || error.status !== 404) throw error;
    deleted = await provider.isSubscriptionDeleted(order.subscription_id);
  }
  if (!deleted) {
    throw new SubscriptionLifecycleError("CANCELLATION_PENDING", "O Asaas ainda não confirmou o cancelamento. Contate o suporte antes de repetir a operação.");
  }
  const changed = await transaction(async (client) => {
    const current = await paidCardOrder(client, userId, true);
    if (!current || current.id !== order.id || current.subscription_id !== order.subscription_id) {
      throw new SubscriptionLifecycleError("CANCELLATION_UNAVAILABLE", "A assinatura mudou durante a verificação.");
    }
    if (current.cancellation_state === "confirmed") return false;
    if (!["requested", "unknown"].includes(current.cancellation_state)) {
      throw new SubscriptionLifecycleError("CANCELLATION_UNAVAILABLE", "O estado do cancelamento mudou.");
    }
    await client.query(`
      UPDATE billing_order SET cancellation_state = 'confirmed',
        cancellation_confirmed_at = NOW(), updated_at = NOW() WHERE id = $1
    `, [order.id]);
    return true;
  });
  const status = await getBillingStatus(userId);
  if (changed && (status.paidUntil || order.period_end)) {
    try {
      await sendSubscriptionCancellationEmail(order.email, new Date(status.paidUntil ?? order.period_end!));
    } catch { /* The confirmed cancellation remains effective. */ }
  }
  return status;
}
