import { getDb } from "./db";

export async function recordCatalogExport(userId: string): Promise<void> {
  try {
    await getDb().query(
      "INSERT INTO operational_account_event (user_id, event_type) VALUES ($1, 'csv_exported')",
      [userId],
    );
  } catch {
    // An analytics outage must not prevent a user's CSV export.
  }
}
