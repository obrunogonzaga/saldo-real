import { getDb } from "./db";

export async function recordOperationalFailure(kind: "email" | "webhook"): Promise<void> {
  try {
    await getDb().query("INSERT INTO operational_failure_event (kind) VALUES ($1)", [kind]);
  } catch {
    // Preserve the original provider or webhook failure when telemetry is unavailable.
  }
}
