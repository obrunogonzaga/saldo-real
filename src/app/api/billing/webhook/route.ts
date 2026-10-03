import { NextRequest } from "next/server";

import {
  isSandboxCheckoutEnabled,
  processAsaasCheckoutWebhook,
  verifyAsaasWebhookToken,
} from "@/lib/server/billing";
import {
  isSubscriptionPaymentEvent,
  isSubscriptionEvent,
  processSubscriptionPaymentWebhook,
  processSubscriptionWebhook,
  SubscriptionPaymentWebhookError,
} from "@/lib/server/subscription-payment-webhook";

import {
  billingErrorResponse,
  billingResponse,
  readBillingBody,
} from "../api";
import { recordOperationalFailure } from "@/lib/server/operational-failures";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSandboxCheckoutEnabled()) {
    return billingResponse(
      { error: "Webhook Sandbox indisponível.", code: "WEBHOOK_DISABLED" },
      503,
    );
  }

  try {
    if (!verifyAsaasWebhookToken(request.headers.get("asaas-access-token"))) {
      return billingResponse({ error: "Não autorizado." }, 401);
    }

    const body = await readBillingBody(request);
    const result = isSubscriptionPaymentEvent(body)
      ? await processSubscriptionPaymentWebhook(body)
      : isSubscriptionEvent(body)
        ? await processSubscriptionWebhook(body)
        : await processAsaasCheckoutWebhook(body);

    return billingResponse({ received: true, ...result });
  } catch (error) {
    await recordOperationalFailure("webhook");
    if (error instanceof SubscriptionPaymentWebhookError) {
      return billingResponse({ error: error.message, code: error.code },
        error.code === "RETRY" ? 503 : 422);
    }
    return billingErrorResponse(error);
  }
}
