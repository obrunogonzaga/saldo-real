import { describe, expect, it, vi } from "vitest";
import { argumentsForReport } from "./operations-report";

describe("operations report arguments", () => {
  it("argumentsForReport_hourlyCheck_usesBoundedUtcWindow", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-26T03:00:00Z"));
      expect(argumentsForReport(["--lookback-minutes=90", "--check"]))
        .toEqual({ since: "2026-09-26T01:30:00.000Z", check: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("argumentsForReport_invalidOrAmbiguousWindow_rejects", () => {
    expect(() => argumentsForReport(["--lookback-minutes=0", "--check"])).toThrow();
    expect(() => argumentsForReport(["--since=2026-02-30"])).toThrow();
    expect(() => argumentsForReport(["--since=2026-09-26", "--lookback-minutes=90"])).toThrow();
    expect(() => argumentsForReport(["--account-id=abc", "--lookback-minutes=90", "--check"])).toThrow();
  });
});
