/**
 * Process-local view of the sessions recently served per account (observability for
 * EARLIEST_QUOTA_RENEWAL_FIRST). Keyed by a sha256 prefix of the session key; never holds
 * the raw session identifier, a token or a request body. The persisted pin itself lives in
 * `key_value` (namespace session_account_affinity) and survives restarts; this map only adds
 * the effective model and the last time the session was served.
 */
import { hashSessionKey } from "@/lib/db/accountFailoverEvents";

const MAX_TRACKED_SESSIONS = 5_000;

export interface TrackedSession {
  sessionHash: string;
  provider: string;
  connectionId: string;
  model: string | null;
  lastServedAt: string;
}

declare global {
  var __omnirouteAccountSessionTracker: Map<string, TrackedSession> | undefined;
}

function sessions(): Map<string, TrackedSession> {
  if (!globalThis.__omnirouteAccountSessionTracker) {
    globalThis.__omnirouteAccountSessionTracker = new Map();
  }
  return globalThis.__omnirouteAccountSessionTracker;
}

/** Records a served request and returns the connection the session used before, if any. */
export function trackSessionServed(input: {
  provider: string;
  sessionKey: string | null | undefined;
  connectionId: string;
  model: string | null;
  now?: number;
}): { sessionHash: string | null; previousConnectionId: string | null } {
  const sessionHash = hashSessionKey(input.sessionKey);
  if (!sessionHash) return { sessionHash: null, previousConnectionId: null };
  const map = sessions();
  const key = `${input.provider}:${sessionHash}`;
  const previous = map.get(key) ?? null;
  if (!previous && map.size >= MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.delete(key); // re-insert to keep insertion order = recency
  map.set(key, {
    sessionHash,
    provider: input.provider,
    connectionId: input.connectionId,
    model: input.model,
    lastServedAt: new Date(input.now ?? Date.now()).toISOString(),
  });
  return { sessionHash, previousConnectionId: previous?.connectionId ?? null };
}

export function listRecentSessions(
  provider: string,
  sinceMs: number,
  limit = 50
): TrackedSession[] {
  const out: TrackedSession[] = [];
  for (const entry of [...sessions().values()].reverse()) {
    if (entry.provider !== provider || Date.parse(entry.lastServedAt) < sinceMs) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

export function __resetAccountSessionTrackerForTests() {
  sessions().clear();
}
