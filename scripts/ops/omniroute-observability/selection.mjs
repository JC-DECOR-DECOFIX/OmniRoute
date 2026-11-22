// EARLIEST_QUOTA_RENEWAL_FIRST in the usage report (omni-route-usage/v1, additive fields).
// Read-only, from Omni Route's own records: the routing setting, the persisted session pins
// (hashed keys) and the bounded failover log. The tier of each account mirrors
// src/sse/services/quotaRenewalRanking.ts over this report's own window readings; the
// gateway's live decision is served by GET /api/usage/account-selection.

export const POLICY_NAME = "EARLIEST_QUOTA_RENEWAL_FIRST";
export const STRATEGY = "earliest-quota-renewal";
const MAX_FAILOVER_EVENTS = 20;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const TEXT_RE = /^[A-Za-z0-9 ._:/@()-]{1,160}$/;
const HASH_RE = /^[0-9a-f]{16}$/;

function parseJson(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
const ms = (value) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const match = (value, re) => (typeof value === "string" && re.test(value) ? value : null);

/** The provider's routing override as the gateway resolves it. */
export function readRoutingPolicy(db, provider) {
  const row = db
    .prepare(
      "SELECT value FROM key_value WHERE namespace = 'settings' AND key = 'providerStrategies'"
    )
    .get();
  const override = parseJson(row?.value)?.[provider] ?? {};
  const strategy =
    typeof override.fallbackStrategy === "string" &&
    /^[a-z-]{1,40}$/.test(override.fallbackStrategy)
      ? override.fallbackStrategy
      : "priority";
  const enabled = strategy === STRATEGY;
  const ttl = Number(override.sessionAffinityTtlMs);
  return {
    name: POLICY_NAME,
    strategy,
    enabled,
    sessionAffinityTtlMs: enabled && Number.isFinite(ttl) && ttl > 0 ? ttl : 0,
  };
}

/** Non-expired session pins: count per connection and expiry per 16-hex key hash. */
export function readSessionPins(db, provider, now) {
  const rows = db
    .prepare(
      "SELECT key, value FROM key_value WHERE namespace = 'session_account_affinity' AND key LIKE ?"
    )
    .all(`${provider}:%`);
  const byConnection = new Map();
  const byHash = new Map();
  for (const row of rows) {
    const record = parseJson(row.value);
    const connectionId = match(record?.connectionId, ID_RE);
    const expiresAt = ms(record?.expiresAt);
    if (!connectionId || expiresAt === null || expiresAt <= now) continue;
    byConnection.set(connectionId, (byConnection.get(connectionId) ?? 0) + 1);
    const hash =
      typeof row.key === "string" ? row.key.slice(provider.length + 1, provider.length + 17) : "";
    if (HASH_RE.test(hash))
      byHash.set(hash, { connectionId, expiresAt: new Date(expiresAt).toISOString() });
  }
  return { byConnection, byHash };
}

const CLIENTS = new Set([
  "claude-code-cli",
  "claude-code-vscode",
  "happy-claude-code",
  "agent-sdk",
  "claude-code-other",
  "other",
  "unknown",
]);
const SESSION_WINDOW_MS = 60 * 60_000;
const MAX_SESSIONS = 20;

/** Sessions served in the last hour: account, effective model, client family, last change. */
export function readSessions(db, provider, now, pins, emailOf) {
  const rows = db
    .prepare(
      `SELECT value FROM key_value WHERE namespace = 'account_session_activity' AND key LIKE ?
         AND json_valid(value) = 1 AND json_extract(value, '$.lastServedAt') >= ?
       ORDER BY json_extract(value, '$.lastServedAt') DESC LIMIT ?`
    )
    .all(`${provider}:%`, new Date(now - SESSION_WINDOW_MS).toISOString(), MAX_SESSIONS);
  const sessions = [];
  for (const row of rows) {
    const s = parseJson(row.value);
    const sessionHash = match(s?.sessionHash, HASH_RE);
    const connectionId = match(s?.connectionId, ID_RE);
    const lastServedAt = ms(s?.lastServedAt);
    if (!sessionHash || !connectionId || lastServedAt === null) continue;
    const pin = pins.byHash.get(sessionHash) ?? null;
    const change = s.lastChange && typeof s.lastChange === "object" ? s.lastChange : null;
    sessions.push({
      sessionHash,
      connectionId,
      shortId: connectionId.slice(0, 8),
      email: emailOf(connectionId),
      model: match(s.model, TEXT_RE),
      client: CLIENTS.has(s.client) ? s.client : "unknown",
      firstServedAt:
        ms(s.firstServedAt) !== null ? new Date(ms(s.firstServedAt)).toISOString() : null,
      lastServedAt: new Date(lastServedAt).toISOString(),
      pinned: !!pin && pin.connectionId === connectionId,
      pinExpiresAt: pin && pin.connectionId === connectionId ? pin.expiresAt : null,
      lastChange:
        change && ms(change.at) !== null
          ? {
              at: new Date(ms(change.at)).toISOString(),
              fromConnectionId: match(change.fromConnectionId, ID_RE),
              reason: match(change.reason, TEXT_RE),
            }
          : null,
      source: "omniroute:account_session_activity",
    });
  }
  return sessions;
}

/** The gateway's own last ranking (src/sse/services/quotaRenewalRanking.ts), when recent. */
export const GATEWAY_DECISION_FRESH_MS = 15 * 60_000;
export function readGatewayRanking(db, provider, now) {
  const row = db
    .prepare(
      "SELECT value FROM key_value WHERE namespace = 'account_selection_ranking' AND key = ?"
    )
    .get(provider);
  const ranking = parseJson(row?.value);
  const evaluatedAt = ms(ranking?.evaluatedAt);
  if (!ranking || evaluatedAt === null || !Array.isArray(ranking.ordered)) return null;
  const entry = (d) => {
    const connectionId = match(d?.connectionId, ID_RE);
    if (!connectionId || !["A", "B", "out"].includes(d.tier)) return null;
    return {
      connectionId,
      tier: d.tier,
      position: Number.isInteger(d.position) ? d.position : null,
      reason: match(d.reason, /^[a-z_]{1,64}$/),
      limitingWindow:
        d.limitingWindow === "weekly" || d.limitingWindow === "5h" ? d.limitingWindow : null,
      resetAt: ms(d.resetAt) !== null ? new Date(ms(d.resetAt)).toISOString() : null,
    };
  };
  return {
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    recent: now - evaluatedAt <= GATEWAY_DECISION_FRESH_MS,
    requestedModel: match(ranking.requestedModel, TEXT_RE),
    entries: [...ranking.ordered, ...(Array.isArray(ranking.excluded) ? ranking.excluded : [])]
      .map(entry)
      .filter(Boolean),
  };
}

export function readFailoverEvents(db, provider) {
  const rows = db
    .prepare(
      "SELECT value FROM key_value WHERE namespace = 'account_failover_events' ORDER BY key DESC LIMIT 200"
    )
    .all();
  const events = [];
  for (const row of rows) {
    const event = parseJson(row.value);
    if (!event || event.provider !== provider) continue;
    const to = match(event.toConnectionId, ID_RE);
    const at = ms(event.at);
    if (!to || at === null) continue;
    events.push({
      at: new Date(at).toISOString(),
      kind: event.kind === "manual_pin" ? "manual_pin" : "failover",
      fromConnectionId: match(event.fromConnectionId, ID_RE),
      toConnectionId: to,
      reason: match(event.reason, TEXT_RE),
      model: match(event.model, TEXT_RE),
      sessionHash: match(event.sessionHash, HASH_RE),
      source: "omniroute:account_failover_events",
    });
    if (events.length >= MAX_FAILOVER_EVENTS) break;
  }
  return events;
}

function decide(account, now) {
  if (account.state !== "active") return { tier: "blocked", reason: account.state };
  const { status, windows } = account.quota;
  const weekly = windows.weekly;
  const fiveHour = windows.fiveHour;
  const future = (w) => ms(w?.resetsAt) !== null && ms(w.resetsAt) > now;
  if (weekly && weekly.usedPercent >= 100 && future(weekly)) {
    return {
      tier: "out",
      reason: "weekly_exhausted",
      limitingWindow: "weekly",
      resetAt: weekly.resetsAt,
    };
  }
  if (fiveHour && fiveHour.usedPercent >= 100 && future(fiveHour)) {
    return {
      tier: "out",
      reason: "five_hour_exhausted",
      limitingWindow: "5h",
      resetAt: fiveHour.resetsAt,
    };
  }
  if (status === "unavailable") return { tier: "B", reason: "quota_missing" };
  if (status !== "fresh") return { tier: "B", reason: "quota_stale" };
  if (!weekly) return { tier: "B", reason: "weekly_missing" };
  if (weekly.state === "reset_pending_reading") return { tier: "B", reason: "weekly_reset_passed" };
  if (!future(weekly)) return { tier: "B", reason: "weekly_contradictory" };
  if (fiveHour && fiveHour.state === "reported" && fiveHour.usedPercent > 0 && !future(fiveHour)) {
    return { tier: "B", reason: "five_hour_contradictory" };
  }
  return {
    tier: "A",
    reason: "weekly_usable_earliest_reset",
    limitingWindow: "weekly",
    resetAt: weekly.resetsAt,
  };
}

/**
 * Adds `selection` to each account and returns the pool summary (chosen and reserve).
 * Accounts outside the operator-authorized pool are never ranked.
 */
export function rankAccounts(accounts, { now, authorized, pins, gateway = null }) {
  const pool = accounts.filter((a) => authorized.size === 0 || authorized.has(a.connectionId));
  const useGateway = Boolean(gateway?.recent && gateway.entries.length > 0);
  const byId = new Map((gateway?.entries ?? []).map((e) => [e.connectionId, e]));
  const decided = pool.map((account) => {
    const fromGateway = useGateway ? byId.get(account.connectionId) : null;
    if (useGateway) {
      return fromGateway
        ? { account, ...fromGateway }
        : { account, ...decide(account, now), position: null, outsideGateway: true };
    }
    return { account, ...decide(account, now) };
  });
  const headroom = (a) => {
    const w = a.quota.windows.fiveHour;
    return w && w.state === "reported" ? 100 - w.usedPercent : 100;
  };
  const prio = (a) => (Number.isInteger(a.priority) ? a.priority : 999);
  const tiebreak = (x, y) =>
    prio(x.account) - prio(y.account) || (x.account.connectionId < y.account.connectionId ? -1 : 1);
  let ordered;
  if (useGateway) {
    ordered = decided
      .filter((d) => (d.tier === "A" || d.tier === "B") && Number.isInteger(d.position))
      .sort((x, y) => x.position - y.position);
  } else {
    const tierA = decided
      .filter((d) => d.tier === "A")
      .sort(
        (x, y) =>
          ms(x.resetAt) - ms(y.resetAt) ||
          headroom(y.account) - headroom(x.account) ||
          tiebreak(x, y)
      );
    const tierB = decided.filter((d) => d.tier === "B").sort(tiebreak);
    ordered = [...tierA, ...tierB];
  }
  const source = useGateway ? "omniroute:gateway_ranking" : "observability:mirror";
  for (const account of accounts) {
    const d = decided.find((entry) => entry.account === account);
    const position = d ? ordered.indexOf(d) : -1;
    account.selection = {
      tier: d?.tier ?? "unauthorized",
      position: position >= 0 ? position + 1 : null,
      reason: d?.reason ?? null,
      limitingWindow: d?.limitingWindow ?? null,
      resetAt: d?.resetAt ?? null,
      source: d?.outsideGateway ? "observability:mirror" : source,
    };
    account.sessionPins = pins.byConnection.get(account.connectionId) ?? 0;
  }
  const pick = (d) =>
    d
      ? {
          connectionId: d.account.connectionId,
          shortId: d.account.shortId,
          email: d.account.email,
          tier: d.tier,
          reason: d.reason,
        }
      : null;
  return {
    chosen: pick(ordered[0]),
    reserve: pick(ordered[1]),
    source,
    gatewayEvaluatedAt: gateway?.evaluatedAt ?? null,
  };
}
