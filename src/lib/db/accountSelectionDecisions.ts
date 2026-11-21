/**
 * Last EARLIEST_QUOTA_RENEWAL_FIRST ranking per provider, persisted so the read-only
 * observability service (scripts/ops/omniroute-observability) shows the gateway's own
 * decision. key_value namespace `account_selection_ranking`, one row per provider.
 * The value carries connection ids, tiers, windows and reasons only — no credential.
 */
import { getDbInstance } from "./core";

const NAMESPACE = "account_selection_ranking";

export function saveAccountSelectionRanking(provider: string, ranking: unknown): void {
  if (!/^[a-z0-9-]{1,40}$/.test(provider)) return;
  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, provider, JSON.stringify(ranking));
}

export function loadAccountSelectionRanking(provider: string): unknown | null {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, provider) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
