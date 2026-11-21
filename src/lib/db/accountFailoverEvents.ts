/**
 * Auditable account switches (EARLIEST_QUOTA_RENEWAL_FIRST observability).
 *
 * Stored in `key_value` (namespace `account_failover_events`), bounded to the most recent
 * MAX_EVENTS entries, so no schema migration is needed. Each event holds connection ids,
 * the model, the reason and a sha256 of the session key — never a token, a request body
 * or the raw session identifier.
 */
import { createHash, randomUUID } from "crypto";

import { getDbInstance } from "./core";

const NAMESPACE = "account_failover_events";
export const MAX_ACCOUNT_FAILOVER_EVENTS = 500;

export type AccountFailoverKind = "failover" | "manual_pin";

export interface AccountFailoverEvent {
  at: string;
  provider: string;
  kind: AccountFailoverKind;
  fromConnectionId: string | null;
  toConnectionId: string;
  reason: string | null;
  model: string | null;
  sessionHash: string | null;
  attempts: number | null;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const TEXT_RE = /^[A-Za-z0-9 ._:/@()-]{1,160}$/;

function safeId(value: unknown): string | null {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

function safeText(value: unknown): string | null {
  return typeof value === "string" && TEXT_RE.test(value) ? value : null;
}

export function hashSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

export function recordAccountFailoverEvent(input: {
  provider: string;
  kind: AccountFailoverKind;
  fromConnectionId?: string | null;
  toConnectionId: string;
  reason?: string | null;
  model?: string | null;
  sessionKey?: string | null;
  attempts?: number | null;
  now?: number;
}): AccountFailoverEvent | null {
  const toConnectionId = safeId(input.toConnectionId);
  const provider = safeText(input.provider);
  if (!toConnectionId || !provider) return null;
  const now = input.now ?? Date.now();
  const event: AccountFailoverEvent = {
    at: new Date(now).toISOString(),
    provider,
    kind: input.kind === "manual_pin" ? "manual_pin" : "failover",
    fromConnectionId: safeId(input.fromConnectionId),
    toConnectionId,
    reason: safeText(input.reason),
    model: safeText(input.model),
    sessionHash: hashSessionKey(input.sessionKey),
    attempts: Number.isInteger(input.attempts) ? Number(input.attempts) : null,
  };
  const db = getDbInstance();
  // Sortable key: timestamp first, random suffix against same-millisecond collisions.
  const key = `${String(now).padStart(15, "0")}:${randomUUID().slice(0, 8)}`;
  db.transaction(() => {
    db.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NAMESPACE,
      key,
      JSON.stringify(event)
    );
    db.prepare(
      `DELETE FROM key_value WHERE namespace = ? AND key NOT IN
        (SELECT key FROM key_value WHERE namespace = ? ORDER BY key DESC LIMIT ?)`
    ).run(NAMESPACE, NAMESPACE, MAX_ACCOUNT_FAILOVER_EVENTS);
  })();
  return event;
}

export function listAccountFailoverEvents(
  options: { provider?: string; limit?: number; sinceMs?: number } = {}
): AccountFailoverEvent[] {
  const limit = Math.max(1, Math.min(MAX_ACCOUNT_FAILOVER_EVENTS, options.limit ?? 50));
  const rows = getDbInstance()
    .prepare("SELECT key, value FROM key_value WHERE namespace = ? ORDER BY key DESC")
    .all(NAMESPACE) as Array<{ key: string; value: string }>;
  const events: AccountFailoverEvent[] = [];
  for (const row of rows) {
    let event: AccountFailoverEvent | null = null;
    try {
      event = JSON.parse(row.value) as AccountFailoverEvent;
    } catch {
      continue;
    }
    if (!event || (options.provider && event.provider !== options.provider)) continue;
    if (options.sinceMs !== undefined && Date.parse(event.at) < options.sinceMs) continue;
    events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}
