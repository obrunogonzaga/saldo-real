import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyOrigin } from "@/lib/operational-telemetry";

const query = vi.hoisted(() => vi.fn().mockResolvedValue({ rowCount: 1 }));
vi.mock("@/lib/server/db", () => ({ getDb: () => ({ query }) }));
import { POST } from "./route";

const originalUrl = process.env.BETTER_AUTH_URL;
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3101";

afterEach(() => {
  query.mockClear();
  if (originalUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = originalUrl;
});

function request(body: unknown, origin = "http://127.0.0.1:3101") {
  return new NextRequest("http://127.0.0.1:3101/api/operacoes/evento", {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("operational event intake", () => {
  it("post_foreignOrigin_rejectsWithoutWrite", async () => {
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3101";
    expect((await POST(request({ eventType: "origin", originClass: "direct" }, "https://other.test"))).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("post_extraPayload_rejectsPrivateFields", async () => {
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3101";
    expect((await POST(request({ eventType: "calculation", originClass: "direct", productCost: 50 }))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("post_allowedEvent_storesOnlyFixedCategories", async () => {
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3101";
    expect((await POST(request({ eventType: "calculation", originClass: "internal" }))).status).toBe(204);
    expect(query).toHaveBeenCalledWith(expect.any(String), ["calculation", "internal"]);
  });

  it("classifyOrigin_referrer_reducesToCategory", () => {
    expect(classifyOrigin("https://www.google.com/search?q=private", "https://app.test")).toBe("search");
    expect(classifyOrigin("https://another.test/path?email=private", "https://app.test")).toBe("referral");
    expect(classifyOrigin("https://app.test/page", "https://app.test")).toBe("internal");
  });
});
