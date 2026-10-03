import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { PoolClient } from "pg";

import { PRO_CARD_ITEM_NAME, PRO_MONTHLY_AMOUNT_CENTS, PRO_PIX_ITEM_NAME } from "@/lib/billing-plan";
import { AsaasClientError, createAsaasSandboxClient } from "./asaas-client";
import { getDb } from "./db";

const BILLING_AMOUNT_CENTS = PRO_MONTHLY_AMOUNT_CENTS;
const CHECKOUT_EXPIRATION_MINUTES = 60;

type BillingErrorCode =
  | "BILLING_ALREADY_PRO"
  | "BILLING_DELETION_PENDING"
  | "BILLING_CHECKOUT_DISABLED"
  | "BILLING_CHECKOUT_FAILED"
  | "BILLING_CONFIGURATION_ERROR"
  | "BILLING_METHOD_CONFLICT"
  | "BILLING_ORDER_NOT_FOUND"
  | "BILLING_SUBSCRIPTION_ACTIVE"
  | "BILLING_WEBHOOK_INVALID"
  | "BILLING_WEBHOOK_RETRY";

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BillingOrderView {
  id: string;
  method: "card" | "pix";
  status: "creating" | "checkout_created" | "paid" | "failed";
  link?: string;
  expiresAt?: string;
}

export interface BillingStatus {
  plan: "free" | "pro";
  checkoutEnabled: boolean;
  order?: BillingOrderView;
  paidUntil?: string;
  subscription?: {
    linked: boolean;
    cancellationState: "not_requested" | "requested" | "unknown" | "confirmed";
  };
  renewalIssue?: { dueDate?: string; invoiceUrl?: string };
  recurringRenewal: "not_configured" | "active" | "pending_cancellation" | "cancelled";
}

export interface BillingCheckoutResult extends BillingStatus {
  order: BillingOrderView;
  ambiguous?: boolean;
}

export interface AsaasWebhookResult {
  duplicate: boolean;
  granted: boolean;
  outcome: string;
}

interface BillingOrderRow {
  id: string;
  user_id: string;
  external_reference: string;
  method: "card" | "pix";
  status: BillingOrderView["status"];
  checkout_id: string | null;
  checkout_link: string | null;
  checkout_expires_at: Date | string;
  provider_status: string | null;
  subscription_id: string | null;
  period_end: Date | string | null;
}

interface CardSubscriptionRow {
  subscription_id: string | null;
  initial_payment_id: string | null;
  cancellation_state: "not_requested" | "requested" | "unknown" | "confirmed";
}

interface RenewalIssueRow {
  due_date: Date | string | null;
  invoice_url: string | null;
}

interface WebhookPayload {
  id: string;
  event: "CHECKOUT_CREATED" | "CHECKOUT_CANCELED" | "CHECKOUT_EXPIRED" | "CHECKOUT_PAID";
  accountId: string;
  checkout: {
    id: string;
    externalReference?: string;
    status?: string;
    billingTypes?: string[];
    chargeTypes?: string[];
    items?: Array<{ name?: string; quantity?: number; value?: number }>;
    subscriptionId?: string;
  };
}

function billingError(code: BillingErrorCode, message: string): never {
  throw new BillingError(code, message);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isActivePro(expiresAt: Date | string | null): boolean {
  return Boolean(expiresAt && new Date(expiresAt).getTime() > Date.now());
}

function sandboxCallbackOrigin(): string | null {
  const value = process.env.ASAAS_SANDBOX_CALLBACK_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isSandboxCheckoutEnabled(): boolean {
  const apiKey = process.env.ASAAS_SANDBOX_API_KEY;
  const webhookToken = process.env.ASAAS_SANDBOX_WEBHOOK_TOKEN;

  return (
    process.env.BILLING_SANDBOX_ENABLED === "true" &&
    process.env.APP_ENV !== "production" &&
    process.env.ASAAS_ENV === "sandbox" &&
    Boolean(sandboxCallbackOrigin()) &&
    Boolean(apiKey?.startsWith("$aact_hmlg_")) &&
    Boolean(process.env.ASAAS_SANDBOX_ACCOUNT_ID) &&
    Boolean(webhookToken && webhookToken.length >= 32 && webhookToken.length <= 255)
  );
}

function externalReference(orderId: string): string {
  return `billing-order:${orderId}`;
}

function parseOrderReference(value: string | undefined): string | undefined {
  if (!value?.startsWith("billing-order:")) {
    return undefined;
  }

  const id = value.slice("billing-order:".length);

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  )
    ? id
    : undefined;
}

function saoPauloParts(date: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function saoPauloDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date {
  const localMilliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(localMilliseconds);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = saoPauloParts(candidate);
    const observedMilliseconds = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    candidate = new Date(candidate.getTime() + (localMilliseconds - observedMilliseconds));
  }

  return candidate;
}

export function saoPauloToday(date = new Date()): string {
  const parts = saoPauloParts(date);

  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function addOneCalendarMonth(date = new Date()): Date {
  const parts = saoPauloParts(date);
  const nextMonthIndex = parts.month;
  const year = parts.year + Math.floor(nextMonthIndex / 12);
  const month = (nextMonthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDay);

  return saoPauloDateToUtc(year, month, day, 23, 59, 59);
}

function orderView(row: BillingOrderRow): BillingOrderView {
  return {
    id: row.id,
    method: row.method,
    status: row.status,
    ...(row.checkout_link ? { link: row.checkout_link } : {}),
    ...(row.status === "creating" || row.status === "checkout_created"
      ? { expiresAt: toIsoString(row.checkout_expires_at) }
      : {}),
  };
}

async function lockUser(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM "user" WHERE id = $1 FOR UPDATE',
    [userId],
  );

  if (!result.rows[0]) {
    return billingError("BILLING_ORDER_NOT_FOUND", "Conta não encontrada.");
  }
}

async function getActiveEntitlement(
  client: PoolClient,
  userId: string,
): Promise<Date | string | null> {
  const result = await client.query<{ expires_at: Date | string | null }>(
    "SELECT expires_at FROM account_entitlement WHERE user_id = $1 AND plan = 'pro'",
    [userId],
  );

  return result.rows[0]?.expires_at ?? null;
}

async function latestOrder(
  client: PoolClient,
  userId: string,
): Promise<BillingOrderRow | undefined> {
  const result = await client.query<BillingOrderRow>(
    `
      SELECT
        id, user_id, external_reference, method, status, checkout_id, checkout_link,
        checkout_expires_at, provider_status, subscription_id, period_end
      FROM billing_order
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0];
}

async function currentCardSubscription(
  client: PoolClient,
  userId: string,
): Promise<CardSubscriptionRow | undefined> {
  const result = await client.query<CardSubscriptionRow>(
    `
      SELECT subscription_id, initial_payment_id, cancellation_state
      FROM billing_order
      WHERE user_id = $1 AND method = 'card' AND status = 'paid'
      ORDER BY paid_at DESC, created_at DESC
      LIMIT 1
    `,
    [userId],
  );
  return result.rows[0];
}

async function latestRenewalIssue(client: PoolClient, userId: string): Promise<RenewalIssueRow | undefined> {
  const result = await client.query<RenewalIssueRow>(`
    SELECT p.due_date, p.invoice_url FROM billing_payment_cycle p
    JOIN billing_order b ON b.id = p.order_id
    WHERE p.user_id = $1 AND p.state = 'overdue' AND p.is_initial = FALSE
      AND b.cancellation_state <> 'confirmed'
      AND NOT EXISTS (
        SELECT 1 FROM billing_payment_cycle newer
        WHERE newer.order_id = p.order_id AND newer.state = 'confirmed'
          AND newer.is_initial = FALSE
          AND newer.due_date >= p.due_date
      )
    ORDER BY p.due_date DESC NULLS LAST LIMIT 1
  `, [userId]);
  return result.rows[0];
}

async function withTransaction<T>(
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.access_actor', 'billing_service', TRUE), set_config('app.access_reason', 'verified_checkout_state', TRUE)");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getBillingStatus(userId: string): Promise<BillingStatus> {
  const client = await getDb().connect();

  try {
    const expiresAt = await getActiveEntitlement(client, userId);
    const order = await latestOrder(client, userId);
    const subscription = await currentCardSubscription(client, userId);
    const renewalIssue = await latestRenewalIssue(client, userId);
    const active = isActivePro(expiresAt);

    return {
      plan: active ? "pro" : "free",
      checkoutEnabled: isSandboxCheckoutEnabled(),
      ...(order ? { order: orderView(order) } : {}),
      ...(active && expiresAt ? { paidUntil: toIsoString(expiresAt) } : {}),
      ...(subscription
        ? {
            subscription: {
              linked: Boolean(subscription.subscription_id && subscription.initial_payment_id),
              cancellationState: subscription.cancellation_state,
            },
          }
        : {}),
      ...(renewalIssue ? { renewalIssue: {
        ...(renewalIssue.due_date ? { dueDate: new Date(renewalIssue.due_date).toISOString().slice(0, 10) } : {}),
        ...(renewalIssue.invoice_url ? { invoiceUrl: renewalIssue.invoice_url } : {}),
      } } : {}),
      recurringRenewal: !subscription?.subscription_id || !subscription.initial_payment_id
        ? "not_configured"
        : subscription.cancellation_state === "confirmed" ? "cancelled"
          : subscription.cancellation_state === "not_requested" ? "active" : "pending_cancellation",
    };
  } finally {
    client.release();
  }
}

async function createPendingOrder(userId: string, method: "card" | "pix"): Promise<{
  order: BillingOrderRow;
  shouldCreateCheckout: boolean;
}> {
  return withTransaction(async (client) => {
    await lockUser(client, userId);
    const deletion = await client.query(
      "SELECT id FROM account_deletion_request WHERE user_id = $1 AND status = 'pending_review'",
      [userId],
    );
    if (deletion.rows[0]) {
      return billingError("BILLING_DELETION_PENDING", "Há uma solicitação de exclusão em análise. Não é possível iniciar uma nova compra.");
    }
    const paidUntil = await getActiveEntitlement(client, userId);

    if (isActivePro(paidUntil)) {
      return billingError(
        "BILLING_ALREADY_PRO",
        "Sua conta já possui PRO ativo.",
      );
    }

    const recurring = await client.query<{ id: string }>(`
      SELECT id FROM billing_order
      WHERE user_id = $1 AND method = 'card' AND status = 'paid'
        AND cancellation_state <> 'confirmed'
      ORDER BY paid_at DESC LIMIT 1 FOR UPDATE
    `, [userId]);
    if (recurring.rows[0]) {
      return billingError("BILLING_SUBSCRIPTION_ACTIVE",
        "Há uma assinatura de cartão pendente de cancelamento. Regularize ou cancele antes de iniciar outra compra.");
    }

    const open = await client.query<BillingOrderRow>(
      `
        SELECT
          id, user_id, external_reference, method, status, checkout_id, checkout_link,
          checkout_expires_at, provider_status, subscription_id, period_end
        FROM billing_order
        WHERE user_id = $1 AND status IN ('creating', 'checkout_created')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [userId],
    );

    if (open.rows[0]) {
      if (open.rows[0].method !== method) {
        return billingError(
          "BILLING_METHOD_CONFLICT",
          "Existe um checkout pendente com outro método de pagamento.",
        );
      }

      // A local expiration does not prove that the provider failed to create
      // or process this checkout. Keep it blocked until reconciliation is
      // available in the subscription/payment flow (#13), rather than risk a
      // second recurring card subscription.
      return { order: open.rows[0], shouldCreateCheckout: false };
    }

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRATION_MINUTES * 60 * 1000);
    const result = await client.query<BillingOrderRow>(
      `
        INSERT INTO billing_order (
          id, user_id, external_reference, method, amount_cents, currency,
          status, checkout_expires_at
        ) VALUES ($1, $2, $3, $4, $5, 'BRL', 'creating', $6)
        RETURNING
          id, user_id, external_reference, method, status, checkout_id, checkout_link,
          checkout_expires_at, provider_status, subscription_id, period_end
      `,
      [id, userId, externalReference(id), method, BILLING_AMOUNT_CENTS, expiresAt],
    );

    return { order: result.rows[0]!, shouldCreateCheckout: true };
  });
}

async function readOrder(orderId: string): Promise<BillingOrderRow> {
  const result = await getDb().query<BillingOrderRow>(
    `
      SELECT
        id, user_id, external_reference, method, status, checkout_id, checkout_link,
        checkout_expires_at, provider_status, subscription_id, period_end
      FROM billing_order
      WHERE id = $1
    `,
    [orderId],
  );
  const order = result.rows[0];

  if (!order) {
    return billingError("BILLING_ORDER_NOT_FOUND", "Pedido não encontrado.");
  }

  return order;
}

async function persistCheckout(
  orderId: string,
  checkout: { id: string; link: string; status: string; externalReference: string },
): Promise<BillingOrderRow> {
  return withTransaction(async (client) => {
    const result = await client.query<BillingOrderRow>(
      `
        SELECT
          id, user_id, external_reference, method, status, checkout_id, checkout_link,
          checkout_expires_at, provider_status, subscription_id, period_end
        FROM billing_order
        WHERE id = $1
        FOR UPDATE
      `,
      [orderId],
    );
    const order = result.rows[0];

    if (!order || checkout.externalReference !== order.external_reference) {
      return billingError("BILLING_ORDER_NOT_FOUND", "Pedido não encontrado.");
    }

    if (order.checkout_id && order.checkout_id !== checkout.id) {
      return billingError(
        "BILLING_CHECKOUT_FAILED",
        "Não foi possível conciliar a criação do checkout.",
      );
    }

    const updated = await client.query<BillingOrderRow>(
      `
        UPDATE billing_order
        SET
          checkout_id = COALESCE(checkout_id, $2),
          checkout_link = COALESCE(checkout_link, $3),
          provider_status = COALESCE(provider_status, $4),
          status = CASE WHEN status = 'creating' THEN 'checkout_created' ELSE status END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id, user_id, external_reference, method, status, checkout_id, checkout_link,
          checkout_expires_at, provider_status, subscription_id, period_end
      `,
      [orderId, checkout.id, checkout.link, checkout.status],
    );

    return updated.rows[0]!;
  });
}

function isAmbiguousCheckoutFailure(error: unknown): boolean {
  return (
    !(error instanceof AsaasClientError) ||
    error.code === "TIMEOUT" ||
    error.code === "NETWORK_ERROR" ||
    error.code === "INVALID_RESPONSE"
  );
}

async function markCheckoutFailed(orderId: string, code: string): Promise<void> {
  await getDb().query(
    `
      UPDATE billing_order
      SET status = 'failed', failure_code = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'creating'
    `,
    [orderId, code],
  );
}

async function createCheckout(
  userId: string,
  method: "card" | "pix",
): Promise<BillingCheckoutResult> {
  if (!isSandboxCheckoutEnabled()) {
    return billingError(
      "BILLING_CHECKOUT_DISABLED",
      "O checkout Sandbox não está disponível neste ambiente.",
    );
  }

  const baseUrl = sandboxCallbackOrigin();
  if (!baseUrl) {
    return billingError(
      "BILLING_CONFIGURATION_ERROR",
      "O retorno HTTPS do checkout Sandbox não está configurado.",
    );
  }

  const pending = await createPendingOrder(userId, method);

  if (!pending.shouldCreateCheckout) {
    const status = await getBillingStatus(userId);
    const needsReconciliation =
      pending.order.status === "creating" ||
      new Date(pending.order.checkout_expires_at).getTime() <= Date.now();

    return {
      ...status,
      order: orderView(pending.order),
      ...(needsReconciliation ? { ambiguous: true } : {}),
    };
  }

  try {
    const callbacks = {
      successUrl: `${baseUrl}/app/plano?retorno=sucesso`,
      cancelUrl: `${baseUrl}/app/plano?retorno=cancelado`,
      expiredUrl: `${baseUrl}/app/plano?retorno=expirado`,
    };
    const asaas = createAsaasSandboxClient();
    const checkout =
      method === "card"
        ? await asaas.createRecurringCardCheckout({
            externalReference: pending.order.external_reference,
            callbacks,
            nextDueDate: saoPauloToday(),
          })
        : await asaas.createPixCheckout({
            externalReference: pending.order.external_reference,
            callbacks,
            minutesToExpire: CHECKOUT_EXPIRATION_MINUTES,
          });
    const order = await persistCheckout(pending.order.id, checkout);
    const status = await getBillingStatus(userId);

    return { ...status, order: orderView(order) };
  } catch (error) {
    if (isAmbiguousCheckoutFailure(error)) {
      const order = await readOrder(pending.order.id);
      const status = await getBillingStatus(userId);

      return { ...status, order: orderView(order), ambiguous: true };
    }

    const code = error instanceof AsaasClientError ? error.code : "UNKNOWN";
    await markCheckoutFailed(pending.order.id, code);
    return billingError(
      "BILLING_CHECKOUT_FAILED",
      "Não foi possível criar o checkout Sandbox. Tente novamente.",
    );
  }
}

export async function createCardCheckout(
  userId: string,
): Promise<BillingCheckoutResult> {
  return createCheckout(userId, "card");
}

export async function createPixCheckout(
  userId: string,
): Promise<BillingCheckoutResult> {
  return createCheckout(userId, "pix");
}

function webhookConfigurationToken(): string {
  const token = process.env.ASAAS_SANDBOX_WEBHOOK_TOKEN;

  if (!token || token.length < 32 || token.length > 255) {
    return billingError(
      "BILLING_CONFIGURATION_ERROR",
      "O webhook Sandbox não está configurado.",
    );
  }

  return token;
}

export function verifyAsaasWebhookToken(receivedToken: string | null): boolean {
  const expectedHash = createHash("sha256")
    .update(webhookConfigurationToken())
    .digest();
  const receivedHash = createHash("sha256")
    .update(receivedToken ?? "")
    .digest();

  return timingSafeEqual(expectedHash, receivedHash);
}

function configuredWebhookAccountId(): string {
  const accountId = process.env.ASAAS_SANDBOX_ACCOUNT_ID?.trim();

  if (!accountId) {
    return billingError(
      "BILLING_CONFIGURATION_ERROR",
      "A conta Sandbox do webhook não está configurada.",
    );
  }

  return accountId;
}

function parseWebhookPayload(value: unknown): WebhookPayload {
  if (!value || typeof value !== "object") {
    return billingError("BILLING_WEBHOOK_INVALID", "Evento de checkout inválido.");
  }

  const payload = value as Record<string, unknown>;
  const eventId = typeof payload.id === "string" ? payload.id.trim() : "";
  const event = typeof payload.event === "string" ? payload.event : "";
  const account = payload.account as Record<string, unknown> | undefined;
  const checkout = payload.checkout as Record<string, unknown> | undefined;
  const accountId = typeof account?.id === "string" ? account.id : "";
  const checkoutId = typeof checkout?.id === "string" ? checkout.id : "";

  if (
    !eventId ||
    !event.startsWith("CHECKOUT_") ||
    !accountId ||
    !checkoutId ||
    ![
      "CHECKOUT_CREATED",
      "CHECKOUT_CANCELED",
      "CHECKOUT_EXPIRED",
      "CHECKOUT_PAID",
    ].includes(event)
  ) {
    return billingError("BILLING_WEBHOOK_INVALID", "Evento de checkout inválido.");
  }

  const items = Array.isArray(checkout?.items)
    ? checkout.items.map((item) => {
        const value = item as Record<string, unknown>;

        return {
          ...(typeof value.name === "string" ? { name: value.name } : {}),
          ...(typeof value.quantity === "number"
            ? { quantity: value.quantity }
            : {}),
          ...(typeof value.value === "number" ? { value: value.value } : {}),
        };
      })
    : undefined;
  const subscription = checkout?.subscription as Record<string, unknown> | undefined;

  return {
    id: eventId,
    event: event as WebhookPayload["event"],
    accountId,
    checkout: {
      id: checkoutId,
      ...(typeof checkout?.externalReference === "string"
        ? { externalReference: checkout.externalReference }
        : {}),
      ...(typeof checkout?.status === "string" ? { status: checkout.status } : {}),
      ...(Array.isArray(checkout?.billingTypes)
        ? { billingTypes: checkout.billingTypes.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(Array.isArray(checkout?.chargeTypes)
        ? { chargeTypes: checkout.chargeTypes.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(items ? { items } : {}),
      ...(typeof subscription?.id === "string" ? { subscriptionId: subscription.id } : {}),
    },
  };
}

function isPaidCheckoutOfferValid(
  checkout: WebhookPayload["checkout"],
  method: BillingOrderRow["method"],
): boolean {
  const item = checkout.items?.[0];
  const valueCents = item?.value === undefined ? undefined : Math.round(item.value * 100);
  // Existing Sandbox checkouts retain their original item names after the rebrand.

  return (
    checkout.billingTypes?.includes(method === "card" ? "CREDIT_CARD" : "PIX") === true &&
    checkout.chargeTypes?.includes(method === "card" ? "RECURRENT" : "DETACHED") === true &&
    checkout.items?.length === 1 &&
    (method === "card"
      ? [PRO_CARD_ITEM_NAME, "PreçoPronto PRO"].includes(item?.name ?? "")
      : [PRO_PIX_ITEM_NAME, "PreçoPronto PRO — 1 mês", "PreçoPronto PRO"].includes(item?.name ?? "")) &&
    item?.quantity === 1 &&
    valueCents === BILLING_AMOUNT_CENTS
  );
}

async function lockOrderForWebhook(
  client: PoolClient,
  payload: WebhookPayload,
  forUpdate = false,
): Promise<BillingOrderRow | undefined> {
  const lockClause = forUpdate ? "FOR UPDATE" : "";
  const referencedId = parseOrderReference(payload.checkout.externalReference);
  const result = referencedId
    ? await client.query<BillingOrderRow>(
        `
          SELECT
            id, user_id, external_reference, method, status, checkout_id, checkout_link,
            checkout_expires_at, provider_status, subscription_id, period_end
          FROM billing_order
          WHERE id = $1
          ${lockClause}
        `,
        [referencedId],
      )
    : await client.query<BillingOrderRow>(
        `
          SELECT
            id, user_id, external_reference, method, status, checkout_id, checkout_link,
            checkout_expires_at, provider_status, subscription_id, period_end
          FROM billing_order
          WHERE checkout_id = $1
          ${lockClause}
        `,
        [payload.checkout.id],
      );
  const order = result.rows[0];

  if (!order) {
    return undefined;
  }

  if (
    payload.checkout.externalReference !== undefined &&
    payload.checkout.externalReference !== order.external_reference
  ) {
    return undefined;
  }

  if (order.checkout_id && order.checkout_id !== payload.checkout.id) {
    return undefined;
  }

  return order;
}

async function recordWebhookOutcome(
  client: PoolClient,
  eventId: string,
  orderId: string | undefined,
  outcome: string,
): Promise<void> {
  await client.query(
    `
      UPDATE billing_webhook_event
      SET order_id = $2, outcome = $3, processed_at = NOW()
      WHERE event_id = $1
    `,
    [eventId, orderId ?? null, outcome],
  );
}

async function grantFirstPeriod(
  client: PoolClient,
  order: BillingOrderRow,
  payload: WebhookPayload,
): Promise<boolean> {
  const activeUntil = await getActiveEntitlement(client, order.user_id);

  if (isActivePro(activeUntil)) {
    await client.query(
      `
        UPDATE billing_order
        SET
          checkout_id = COALESCE(checkout_id, $2),
          provider_status = $3,
          subscription_id = COALESCE(subscription_id, $4),
          status = 'paid',
          period_start = COALESCE(period_start, NOW()),
          period_end = COALESCE(period_end, $5),
          paid_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        order.id,
        payload.checkout.id,
        payload.checkout.status ?? "PAID",
        payload.checkout.subscriptionId ?? null,
        activeUntil,
      ],
    );

    return false;
  }

  const periodStart = new Date();
  const periodEnd = addOneCalendarMonth(periodStart);

  await client.query(
    `
      UPDATE billing_order
      SET
        checkout_id = COALESCE(checkout_id, $2),
        provider_status = $3,
        subscription_id = COALESCE(subscription_id, $4),
        status = 'paid',
        period_start = $5,
        period_end = $6,
        paid_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      order.id,
      payload.checkout.id,
      payload.checkout.status ?? "PAID",
      payload.checkout.subscriptionId ?? null,
      periodStart,
      periodEnd,
    ],
  );
  await client.query(
    `
      INSERT INTO account_entitlement (user_id, plan, expires_at, updated_at)
      VALUES ($1, 'pro', $2, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET plan = 'pro', expires_at = EXCLUDED.expires_at, updated_at = NOW()
    `,
    [order.user_id, periodEnd],
  );

  return true;
}

export async function processAsaasCheckoutWebhook(
  value: unknown,
): Promise<AsaasWebhookResult> {
  const payload = parseWebhookPayload(value);

  if (payload.accountId !== configuredWebhookAccountId()) {
    return billingError("BILLING_WEBHOOK_INVALID", "Evento de checkout inválido.");
  }

  return withTransaction(async (client) => {
    const inserted = await client.query<{ event_id: string }>(
      `
        INSERT INTO billing_webhook_event (event_id, checkout_id, event_type, outcome)
        VALUES ($1, $2, $3, 'received')
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `,
      [payload.id, payload.checkout.id, payload.event],
    );

    if (!inserted.rows[0]) {
      return { duplicate: true, granted: false, outcome: "duplicate" };
    }

    const discoveredOrder = await lockOrderForWebhook(client, payload);

    if (!discoveredOrder) {
      if (payload.event === "CHECKOUT_PAID") {
        // Do not deduplicate an uncorrelated paid event: the provider must be
        // able to retry after the checkout id/external reference is persisted.
        return billingError(
          "BILLING_WEBHOOK_RETRY",
          "Evento pago sem correlação segura com o pedido.",
        );
      }

      await recordWebhookOutcome(client, payload.id, undefined, "unmatched");
      return { duplicate: false, granted: false, outcome: "unmatched" };
    }

    // Keep the same user → order lock order used by checkout creation, so a
    // paid webhook and a new checkout cannot deadlock or grant twice.
    await lockUser(client, discoveredOrder.user_id);
    const order = await lockOrderForWebhook(client, payload, true);

    if (!order) {
      if (payload.event === "CHECKOUT_PAID") {
        return billingError(
          "BILLING_WEBHOOK_RETRY",
          "Evento pago sem correlação segura com o pedido.",
        );
      }

      await recordWebhookOutcome(client, payload.id, undefined, "unmatched");
      return { duplicate: false, granted: false, outcome: "unmatched" };
    }

    if (payload.event === "CHECKOUT_PAID") {
      if (!isPaidCheckoutOfferValid(payload.checkout, order.method)) {
        await recordWebhookOutcome(client, payload.id, order.id, "rejected_offer");
        return { duplicate: false, granted: false, outcome: "rejected_offer" };
      }

      if (order.status === "paid") {
        await recordWebhookOutcome(client, payload.id, order.id, "already_paid");
        return { duplicate: false, granted: false, outcome: "already_paid" };
      }

      const granted = await grantFirstPeriod(client, order, payload);
      const outcome = granted ? "paid" : "paid_duplicate_financial";
      await recordWebhookOutcome(client, payload.id, order.id, outcome);
      return { duplicate: false, granted, outcome };
    }

    if (order.status === "paid") {
      await recordWebhookOutcome(client, payload.id, order.id, "ignored_paid");
      return { duplicate: false, granted: false, outcome: "ignored_paid" };
    }

    if (order.status === "failed") {
      await recordWebhookOutcome(client, payload.id, order.id, "ignored_out_of_order");
      return { duplicate: false, granted: false, outcome: "ignored_out_of_order" };
    }

    const status =
      payload.event === "CHECKOUT_CREATED" ? "checkout_created" : "failed";
    await client.query(
      `
        UPDATE billing_order
        SET
          checkout_id = COALESCE(checkout_id, $2),
          provider_status = $3,
          status = $4,
          updated_at = NOW()
        WHERE id = $1
      `,
      [order.id, payload.checkout.id, payload.checkout.status ?? payload.event, status],
    );
    await recordWebhookOutcome(client, payload.id, order.id, payload.event.toLowerCase());

    return {
      duplicate: false,
      granted: false,
      outcome: payload.event.toLowerCase(),
    };
  });
}
