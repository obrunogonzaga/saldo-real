import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { config } from "dotenv";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ProductWriteInput } from "@/lib/products";

config({ path: ".env.local", quiet: true });

const isolated = vi.hoisted(() => ({ pool: null as Pool | null }));

vi.mock("./db", () => ({
  getDb: () => {
    if (!isolated.pool) {
      throw new Error("Test database missing");
    }

    return isolated.pool;
  },
}));

import {
  confirmBatchReprice,
  createBatchRepricePreview,
} from "./batch-reprice";
import { createProduct, updateProduct } from "./products";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const createdUsers = new Set<string>();

function testDatabaseUrl(): URL {
  const rawUrl = process.env.TEST_DATABASE_URL;

  if (!rawUrl) {
    throw new Error("Test database missing");
  }

  const url = new URL(rawUrl);
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(
    url.hostname.replace(/^\[|\]$/g, ""),
  );

  if (!isLoopback || url.pathname !== "/precopronto_integration") {
    throw new Error("Use the dedicated loopback integration database.");
  }

  return url;
}

async function createActor(prefix: string, pro = true): Promise<string> {
  const id = randomUUID();
  createdUsers.add(id);
  await isolated.pool!.query(
    `
      INSERT INTO "user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt",
        terms_accepted, terms_version, privacy_version, marketing_consent
      ) VALUES ($1, 'Teste', $2, TRUE, NOW(), NOW(), TRUE, '2026-09-22', '2026-09-22', FALSE)
    `,
    [id, `${prefix}-${id}@precopronto.test`],
  );

  if (pro) {
    await isolated.pool!.query(
      "INSERT INTO account_entitlement (user_id, plan, expires_at) VALUES ($1, 'pro', NOW() + INTERVAL '1 day')",
      [id],
    );
  }

  return id;
}

function productInput(
  sku: string,
  options: {
    channelId?: "mercado_livre" | "shopee";
    currentPrice?: number;
    name?: string;
  } = {},
): ProductWriteInput {
  return {
    sku,
    name: options.name ?? `Produto ${sku}`,
    ...(options.currentPrice === undefined
      ? {}
      : { currentPrice: options.currentPrice }),
    draft: {
      version: 1,
      channelId: options.channelId ?? "shopee",
      tariffMode: "manual",
      confirmedDropOff: false,
      excludeTax: false,
      input: {
        productCost: 10,
        packaging: 3,
        sellerShipping: 0,
        desiredMarginPercent: 20,
        commissionPercent: 16,
        taxPercent: 6,
        fixedFee: 6,
        mode: "margin_to_price",
      },
    },
  };
}

async function insertFixtures(userId: string, count: number): Promise<string[]> {
  const draft = productInput("fixture").draft;
  const result = {
    productCost: 10,
    packaging: 3,
    sellerShipping: 0,
    fixedFee: 6,
    commission: 4,
    tax: 1,
    netProfit: 2,
    profitPercent: 10,
    suggestedPrice: 40,
  };
  const ids = Array.from({ length: count }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );

  await isolated.pool!.query(
    `
      INSERT INTO catalog_product (
        id, user_id, sku, name, product_cost, packaging, seller_shipping,
        tax_percent, commission_percent, fixed_fee, desired_margin_percent,
        channel_id, tariff_mode, confirmed_drop_off, evaluated_draft,
        evaluated_result, rule_version
      )
      SELECT
        batch.id,
        $1,
        'batch-sku-' || batch.position::text,
        'Produto batch ' || batch.position::text,
        10, 3, 0, 6, 16, 6, 20,
        'shopee', 'manual', FALSE, $2::jsonb, $3::jsonb, 'manual-v1'
      FROM UNNEST($4::text[]) WITH ORDINALITY AS batch(id, position)
    `,
    [userId, JSON.stringify(draft), JSON.stringify(result), ids],
  );

  await isolated.pool!.query(
    `
      INSERT INTO catalog_product_evaluation (
        id, product_id, product_version, evaluated_draft,
        evaluated_input, evaluated_result, rule_version
      )
      SELECT gen_random_uuid()::text, product.id, 1, product.evaluated_draft,
        product.evaluated_draft -> 'input', product.evaluated_result, product.rule_version
      FROM catalog_product product
      WHERE product.id = ANY($1::text[])
    `,
    [ids],
  );

  return ids;
}

async function snapshotCount(productId: string): Promise<number> {
  const result = await isolated.pool!.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM catalog_product_evaluation WHERE product_id = $1",
    [productId],
  );

  return Number(result.rows[0]?.count ?? 0);
}

suite("batch reprice integration", () => {
  beforeAll(async () => {
    const url = testDatabaseUrl();
    isolated.pool = new Pool({ connectionString: url.toString() });
    const [productsSql, batchSql] = await Promise.all([
      readFile(new URL("../../../migrations/0002_products.sql", import.meta.url), "utf8"),
      readFile(new URL("../../../migrations/0004_batch_reprice.sql", import.meta.url), "utf8"),
    ]);

    await isolated.pool.query(productsSql);
    await isolated.pool.query(batchSql);
  });

  afterAll(async () => {
    if (isolated.pool) {
      await isolated.pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        [...createdUsers],
      ]);
      await isolated.pool.end();
      isolated.pool = null;
    }
  });

  it("createBatchRepricePreview_centsAndCurrentPrice_reportsTargetRiskWithoutWriting", async () => {
    const actor = await createActor("batch-cents");
    const product = await createProduct(
      actor,
      productInput("CENTS", { currentPrice: 15 }),
    );
    const preview = await createBatchRepricePreview(actor, {
      ids: [product.id],
      changes: { costAdjustmentPercent: 12.5 },
    });
    const persisted = await isolated.pool!.query<{
      product_cost: number;
      version: number;
    }>("SELECT product_cost, version FROM catalog_product WHERE id = $1", [product.id]);

    expect(preview.rows[0]).toMatchObject({
      oldCost: 10,
      currentPrice: 15,
      newCost: 11.25,
      belowTarget: true,
      errors: [],
    });
    expect(persisted.rows[0]).toMatchObject({ product_cost: 10, version: 1 });
  });

  it("createBatchRepricePreview_dropOffFixedFee_requiresManualRule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    try {
      const actor = await createActor("batch-dropoff-fee");
      const input = productInput("DROP-OFF", { channelId: "mercado_livre" });
      input.draft.tariffMode = "ml_drop_off";
      input.draft.confirmedDropOff = true;
      input.draft.input.fixedFee = 0;
      const product = await createProduct(actor, input);

      const blocked = await createBatchRepricePreview(actor, {
        ids: [product.id],
        changes: { fixedFee: 7 },
      });
      const manual = await createBatchRepricePreview(actor, {
        ids: [product.id],
        changes: { tariffMode: "manual", fixedFee: 7 },
      });

      expect(blocked).toMatchObject({ validCount: 0, invalidCount: 1 });
      expect(blocked.rows[0]?.errors.join(" ")).toContain("regra manual");
      expect(manual).toMatchObject({ validCount: 1, invalidCount: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("createBatchRepricePreview_tariffChange_requiresExplicitCompatibleConfirmation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    try {
      const actor = await createActor("batch-tariff");
      const shopee = await createProduct(actor, productInput("SHOPEE"));
      const mercadoLivre = await createProduct(
        actor,
        productInput("ML", { channelId: "mercado_livre" }),
      );

      await expect(
        createBatchRepricePreview(actor, {
          ids: [mercadoLivre.id],
          changes: { tariffMode: "ml_drop_off" },
        }),
      ).rejects.toMatchObject({ code: "INVALID_PRODUCT" });

      const invalidChannel = await createBatchRepricePreview(actor, {
        ids: [shopee.id],
        changes: { tariffMode: "ml_drop_off", confirmedDropOff: true },
      });
      const validChange = await createBatchRepricePreview(actor, {
        ids: [mercadoLivre.id],
        changes: { tariffMode: "ml_drop_off", confirmedDropOff: true },
      });

      expect(invalidChannel.rows[0]?.errors.join(" ")).toContain("Mercado Livre");
      expect(validChange.rows[0]).toMatchObject({ errors: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("createBatchRepricePreview_freePlanAndForeignId_doNotExposeProducts", async () => {
    const owner = await createActor("batch-owner");
    const freeUser = await createActor("batch-free", false);
    const product = await createProduct(owner, productInput("ISOLADO"));

    await expect(
      createBatchRepricePreview(freeUser, {
        ids: [product.id],
        changes: { fixedFee: 5 },
      }),
    ).rejects.toMatchObject({ code: "BATCH_PRO_REQUIRED" });

    const otherPro = await createActor("batch-other");
    const preview = await createBatchRepricePreview(otherPro, {
      ids: [product.id],
      changes: { fixedFee: 5 },
    });

    expect(preview.rows[0]).toMatchObject({
      id: product.id,
      sku: "",
      errors: ["Produto não encontrado."],
    });
  });

  it("confirmBatchReprice_retryIsIdempotentAndPreservesSnapshots", async () => {
    const actor = await createActor("batch-retry");
    const product = await createProduct(actor, productInput("RETRY"));
    const preview = await createBatchRepricePreview(actor, {
      ids: [product.id],
      changes: { desiredMarginPercent: 30 },
    });

    const first = await confirmBatchReprice(actor, {
      previewId: preview.previewId,
      allowPartial: false,
    });
    const retry = await confirmBatchReprice(actor, {
      previewId: preview.previewId,
      allowPartial: true,
    });

    expect(first).toEqual({ updated: 1, skipped: 0, errors: [] });
    expect(retry).toEqual(first);
    expect(await snapshotCount(product.id)).toBe(2);
  });

  it("confirmBatchReprice_conflictRollsBackOrPartiallyContinues", async () => {
    const actor = await createActor("batch-conflict");
    const first = await createProduct(actor, productInput("CONFLICT-A"));
    const second = await createProduct(actor, productInput("CONFLICT-B"));
    const atomicPreview = await createBatchRepricePreview(actor, {
      ids: [first.id, second.id],
      changes: { commissionPercent: 20 },
    });

    await updateProduct(actor, first.id, first.version, productInput("CONFLICT-A", { name: "Outra aba" }));

    await expect(
      confirmBatchReprice(actor, {
        previewId: atomicPreview.previewId,
        allowPartial: false,
      }),
    ).rejects.toMatchObject({ code: "BATCH_CONFLICT" });
    expect(await snapshotCount(second.id)).toBe(1);

    const partialPreview = await createBatchRepricePreview(actor, {
      ids: [first.id, second.id],
      changes: { taxPercent: 8 },
    });
    const currentFirst = await isolated.pool!.query<{ version: number }>(
      "SELECT version FROM catalog_product WHERE id = $1",
      [first.id],
    );
    await updateProduct(
      actor,
      first.id,
      currentFirst.rows[0]!.version,
      productInput("CONFLICT-A", { name: "Outra aba 2" }),
    );

    const partial = await confirmBatchReprice(actor, {
      previewId: partialPreview.previewId,
      allowPartial: true,
    });

    expect(partial).toMatchObject({ updated: 1, skipped: 1 });
    expect(partial.errors[0]?.id).toBe(first.id);
    expect(await snapshotCount(second.id)).toBe(2);
  });

  it("confirmBatchReprice_fiveHundredProducts_referenceFlow", async () => {
    const actor = await createActor("batch-500");
    const ids = await insertFixtures(actor, 500);
    const previewStartedAt = Date.now();
    const preview = await createBatchRepricePreview(actor, {
      ids,
      changes: { fixedFee: 7 },
    });
    const previewMs = Date.now() - previewStartedAt;

    expect(preview).toMatchObject({ validCount: 500, invalidCount: 0 });
    expect(previewMs).toBeLessThan(10_000);

    const confirmStartedAt = Date.now();
    const result = await confirmBatchReprice(actor, {
      previewId: preview.previewId,
      allowPartial: false,
    });
    const confirmMs = Date.now() - confirmStartedAt;
    const persisted = await isolated.pool!.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM catalog_product WHERE user_id = $1 AND version = 2 AND fixed_fee = 7",
      [actor],
    );

    expect(result).toMatchObject({ updated: 500, skipped: 0, errors: [] });
    expect(Number(persisted.rows[0]?.count)).toBe(500);
    expect(await snapshotCount(ids[0])).toBe(2);
    expect(await snapshotCount(ids[499])).toBe(2);
    expect(await confirmBatchReprice(actor, {
      previewId: preview.previewId,
      allowPartial: false,
    })).toEqual(result);
    console.info(`Recálculo 500: prévia ${previewMs} ms; confirmação ${confirmMs} ms.`);
  }, 60_000);
});
