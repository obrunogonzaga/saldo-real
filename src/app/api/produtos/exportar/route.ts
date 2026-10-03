import { NextRequest } from "next/server";
import { createCatalogExport } from "@/lib/catalog-export";
import { ProductValidationError } from "@/lib/products";
import { listProducts } from "@/lib/server/products";
import { recordCatalogExport } from "@/lib/server/operational-actions";
import {
  authIsEnabled,
  getVerifiedUserId,
  hasTrustedOrigin,
  noStoreResponse,
  productErrorResponse,
  readProductBody,
  unavailableResponse,
} from "../api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function validateIds(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object")
    throw new ProductValidationError("Seleção inválida.");
  const ids = (value as Record<string, unknown>).ids;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500)
    throw new ProductValidationError("Selecione até 500 produtos.");
  const unique = new Set<string>();
  for (const id of ids) {
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    )
      throw new ProductValidationError("Seleção inválida.");
    unique.add(id);
  }
  if (unique.size !== ids.length)
    throw new ProductValidationError("Seleção inválida.");
  return ids;
}

export async function POST(request: NextRequest) {
  if (!authIsEnabled()) return unavailableResponse();
  if (!hasTrustedOrigin(request))
    return noStoreResponse({ error: "Origem inválida." }, 403);
  try {
    const userId = await getVerifiedUserId(request);
    if (!userId)
      return noStoreResponse({ error: "Entre novamente para continuar." }, 401);
    const ids = validateIds(await readProductBody(request));
    const { products } = await listProducts(userId, { status: "all" });
    const selected = ids
      ? products.filter((product) => ids.includes(product.id))
      : products;
    if (ids && selected.length !== ids.length)
      return noStoreResponse({ error: "Produto não encontrado." }, 404);
    const csv = createCatalogExport(selected);
    await recordCatalogExport(userId);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="precos-liquido.csv"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return productErrorResponse(error);
  }
}
