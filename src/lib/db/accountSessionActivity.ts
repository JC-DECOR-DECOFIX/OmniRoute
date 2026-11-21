/**
 * Recent activity per session (EARLIEST_QUOTA_RENEWAL_FIRST observability): the account and
 * effective model that last served each session, the client family, and the last account
 * change with its reason. key_value namespace `account_session_activity`, key
 * `<provider>:<sessionHash>` where sessionHash equals the first 16 hex chars of the session pin
 * key. No raw session identifier, token or request body is stored. Rows older than
 * RETENTION_MS are pruned on write.
 */
import { getDbInstance } from "./core";

const NAMESPACE = "account_session_activity";
export const SESSION_ACTIVITY_RETENTION_MS = 24 * 60 * 60_000;
const PRUNE_EVERY_WRITES = 200;
let writesSincePrune = 0;

export interface SessionActivity {
  provider: string;
  sessionHash: string;
  connectionId: string;
  model: string | null;
  client: string;
  firstServedAt: string;
  lastServedAt: string;
  lastChange: {
    at: string;
    fromConnectionId: string | null;
    reason: string;
  } | null;
}

export function readSessionActivity(provider: string, sessionHash: string): SessionActivity | null {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, `${provider}:${sessionHash}`) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as SessionActivity;
  } catch {
    return null;
  }
}

export function writeSessionActivity(activity: SessionActivity, now: number = Date.now()): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    `${activity.provider}:${activity.sessionHash}`,
    JSON.stringify(activity)
  );
  writesSincePrune += 1;
  if (writesSincePrune >= PRUNE_EVERY_WRITES) {
    writesSincePrune = 0;
    pruneSessionActivity(now);
  }
}

export function pruneSessionActivity(now: number = Date.now()): number {
  const cutoff = new Date(now - SESSION_ACTIVITY_RETENTION_MS).toISOString();
  return getDbInstance()
    .prepare(
      `DELETE FROM key_value WHERE namespace = ?
        AND (json_valid(value) = 0 OR json_extract(value, '$.lastServedAt') < ?)`
    )
    .run(NAMESPACE, cutoff).changes as number;
}

export function listSessionActivity(
  provider: string,
  sinceMs: number,
  limit = 50
): SessionActivity[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT value FROM key_value WHERE namespace = ? AND key LIKE ?
         AND json_valid(value) = 1 AND json_extract(value, '$.lastServedAt') >= ?
       ORDER BY json_extract(value, '$.lastServedAt') DESC LIMIT ?`
    )
    .all(NAMESPACE, `${provider}:%`, new Date(sinceMs).toISOString(), limit) as Array<{
    value: string;
  }>;
  return rows.map((row) => JSON.parse(row.value) as SessionActivity);
}
