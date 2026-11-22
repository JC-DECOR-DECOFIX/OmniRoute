/**
 * Per-session activity for the account-selection report (EARLIEST_QUOTA_RENEWAL_FIRST): which
 * account and effective model served each session, from which client family, and the last
 * account change with its reason. Persisted (src/lib/db/accountSessionActivity.ts) so the
 * read-only observability service can publish it; writes are skipped while nothing changes
 * for a session, except once per WRITE_INTERVAL_MS to refresh `lastServedAt`.
 */
import { hashSessionKey } from "@/lib/db/accountFailoverEvents";
import {
  listSessionActivity,
  readSessionActivity,
  writeSessionActivity,
  type SessionActivity,
} from "@/lib/db/accountSessionActivity";

const WRITE_INTERVAL_MS = 60_000;
const MAX_CACHED = 5_000;

export type AccountChangeReason = "failover" | "manual_pin" | "reselected";

/**
 * Client family from Claude Code's User-Agent `claude-cli/<v> (external, <entrypoint>[, …])`.
 * Happy runs the Claude Code binary through claude-happy-gateway, which declares `sdk-cli`.
 */
export function classifyClaudeClient(userAgent: string | null | undefined): string {
  const ua = typeof userAgent === "string" ? userAgent : "";
  const match = /^claude-cli\/[\d.]+ \(external, ([a-z-]+)/i.exec(ua);
  if (!match) return ua ? "other" : "unknown";
  const entrypoint = match[1].toLowerCase();
  if (entrypoint === "cli") return "claude-code-cli";
  if (entrypoint === "claude-vscode") return "claude-code-vscode";
  if (entrypoint === "sdk-cli") return "happy-claude-code";
  if (entrypoint === "sdk-ts" || entrypoint === "sdk-py") return "agent-sdk";
  return "claude-code-other";
}

declare global {
  var __omnirouteAccountSessionCache: Map<string, SessionActivity> | undefined;
}

function cache(): Map<string, SessionActivity> {
  if (!globalThis.__omnirouteAccountSessionCache) {
    globalThis.__omnirouteAccountSessionCache = new Map();
  }
  return globalThis.__omnirouteAccountSessionCache;
}

/** Records a served request; returns the account the session used before, if any. */
export function trackSessionServed(input: {
  provider: string;
  sessionKey: string | null | undefined;
  connectionId: string;
  model: string | null;
  userAgent?: string | null;
  changeReason?: AccountChangeReason | null;
  changeDetail?: string | null;
  now?: number;
}): { sessionHash: string | null; previousConnectionId: string | null } {
  const sessionHash = hashSessionKey(input.provider, input.sessionKey);
  if (!sessionHash) return { sessionHash: null, previousConnectionId: null };
  const now = input.now ?? Date.now();
  const at = new Date(now).toISOString();
  const key = `${input.provider}:${sessionHash}`;
  const map = cache();
  const previous = map.get(key) ?? readSessionActivity(input.provider, sessionHash);
  const client = classifyClaudeClient(input.userAgent);
  const moved = !!previous && previous.connectionId !== input.connectionId;
  const next: SessionActivity = {
    provider: input.provider,
    sessionHash,
    connectionId: input.connectionId,
    model: input.model,
    client: client === "unknown" && previous ? previous.client : client,
    firstServedAt: previous?.firstServedAt ?? at,
    lastServedAt: at,
    lastChange: moved
      ? {
          at,
          fromConnectionId: previous!.connectionId,
          reason: [input.changeReason ?? "reselected", input.changeDetail]
            .filter(Boolean)
            .join(": "),
        }
      : (previous?.lastChange ?? null),
  };
  const unchanged =
    !!previous &&
    !moved &&
    previous.model === next.model &&
    previous.client === next.client &&
    now - Date.parse(previous.lastServedAt) < WRITE_INTERVAL_MS;
  if (!map.has(key) && map.size >= MAX_CACHED) map.clear();
  if (unchanged) {
    map.set(key, previous!);
  } else {
    map.set(key, next);
    writeSessionActivity(next, now);
  }
  return { sessionHash, previousConnectionId: previous?.connectionId ?? null };
}

export function listRecentSessions(provider: string, sinceMs: number, limit = 50) {
  return listSessionActivity(provider, sinceMs, limit);
}

export function __resetAccountSessionTrackerForTests() {
  cache().clear();
}
