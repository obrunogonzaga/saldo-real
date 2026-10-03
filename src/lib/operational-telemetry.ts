export type OriginClass = "direct" | "search" | "referral" | "internal" | "unknown";
export type BrowserEvent = "origin" | "calculation" | "calculation_error";

export function classifyOrigin(referrer: string, currentOrigin: string): OriginClass {
  if (!referrer) return "direct";
  try {
    const url = new URL(referrer);
    if (!['https:', 'http:'].includes(url.protocol)) return "unknown";
    if (url.origin === currentOrigin) return "internal";
    if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia)\.[a-z.]+$/i.test(url.hostname)) {
      return "search";
    }
    return "referral";
  } catch {
    return "unknown";
  }
}

export function recordBrowserEvent(eventType: BrowserEvent, originClass: OriginClass): void {
  if (typeof window === "undefined") return;
  void fetch("/api/operacoes/evento", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType, originClass }),
    credentials: "omit",
    keepalive: true,
  }).catch(() => {});
}
