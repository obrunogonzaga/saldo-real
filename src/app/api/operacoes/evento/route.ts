import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";

export const runtime = "nodejs";
const EVENT_TYPES = new Set(["origin", "calculation", "calculation_error"]);
const ORIGIN_CLASSES = new Set(["direct", "search", "referral", "internal", "unknown"]);

function response(status: number) {
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const configured = process.env.BETTER_AUTH_URL ?? process.env.AUTH_BASE_URL;
  if (!configured) return response(503);
  try {
    if (request.headers.get("origin") !== new URL(configured).origin ||
      request.headers.get("sec-fetch-site") !== "same-origin") return response(403);
    if (request.headers.get("content-type") !== "application/json" ||
      Number(request.headers.get("content-length") ?? 0) > 128) return response(400);
    const raw = await request.text();
    if (raw.length > 128) return response(400);
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return response(400);
    const data = body as Record<string, unknown>;
    if (Object.keys(data).sort().join(",") !== "eventType,originClass" ||
      !EVENT_TYPES.has(data.eventType as string) ||
      !ORIGIN_CLASSES.has(data.originClass as string)) return response(400);
    await getDb().query(`
      INSERT INTO operational_anonymous_event (event_type, origin_class)
      SELECT $1, $2 WHERE (
        SELECT count(*) FROM operational_anonymous_event
        WHERE created_at >= NOW() - INTERVAL '1 minute'
      ) < 1000
    `, [data.eventType, data.originClass]);
    return response(204);
  } catch {
    return response(503);
  }
}
