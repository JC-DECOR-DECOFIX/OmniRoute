// Omni Route observability: builds the account-usage report from Omni Route's own records.
// Read-only. Selects an explicit allowlist of columns; no credential column is ever read.

export const SCHEMA = "omni-route-usage/v1";
export const PROVIDER = "claude";

const QUOTA_FRESH_MS = 10 * 60_000;
const IN_USE_WINDOW_MS = 5 * 60_000;
const SWITCH_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_SWITCHES = 20;

const WINDOW_KEYS = { fiveHour: "session (5h)", weekly: "weekly (7d)" };
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function parseTime(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : null;
}

function stripProviderPrefix(model) {
  if (typeof model !== "string" || !model) return null;
  return model.startsWith(`${PROVIDER}/`) ? model.slice(PROVIDER.length + 1) : model;
}

export function sanitizeReason(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let out = text.trim();
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > 160 ? `${out.slice(0, 157)}…` : out;
}

function readQuotaCache(db, connectionId) {
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = 'providerLimitsCache' AND key = ?")
    .get(connectionId);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function latestSnapshot(db, connectionId, windowKey) {
  return db
    .prepare(
      `SELECT remaining_percentage, next_reset_at, created_at FROM quota_snapshots
        WHERE provider = ? AND connection_id = ? AND window_key = ?
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(PROVIDER, connectionId, windowKey);
}

/**
 * Omni Route keeps two records of the same vendor reading: the Provider Limits cache, stamped
 * with its fetch time, and quota snapshots, written by the background refresh only when a value
 * changes. The newer of the two is the latest confirmed reading of that window.
 */
function windowReading(cache, cacheFetchedAtMs, snapshot, windowKey) {
  const cached = cache?.quotas?.[windowKey];
  const fromCache =
    cached && Number.isFinite(Number(cached.used)) && cacheFetchedAtMs !== null
      ? {
          used: Number(cached.used),
          resetsAtMs: parseTime(cached.resetAt),
          capturedAtMs: cacheFetchedAtMs,
          source: "omniroute:providerLimitsCache",
        }
      : null;
  const snapshotAtMs = parseTime(snapshot?.created_at);
  const fromSnapshot =
    snapshot && Number.isFinite(Number(snapshot.remaining_percentage)) && snapshotAtMs !== null
      ? {
          used: 100 - Number(snapshot.remaining_percentage),
          resetsAtMs: parseTime(snapshot.next_reset_at),
          capturedAtMs: snapshotAtMs,
          source: "omniroute:quota_snapshots",
        }
      : null;
  if (fromCache && fromSnapshot) {
    return fromSnapshot.capturedAtMs > fromCache.capturedAtMs ? fromSnapshot : fromCache;
  }
  // A complete reading newer than the snapshot that omitted this window means the vendor no
  // longer reports it, such as a five-hour window with no session open.
  if (fromSnapshot && cacheFetchedAtMs !== null && cacheFetchedAtMs > fromSnapshot.capturedAtMs) {
    return null;
  }
  return fromCache ?? fromSnapshot;
}

function quotaWindow(reading, now) {
  if (!reading) return null;
  const base = {
    resetsAt: iso(reading.resetsAtMs),
    capturedAt: iso(reading.capturedAtMs),
    source: `anthropic:/api/oauth/usage via ${reading.source}`,
  };
  // A window that has reset since it was read no longer describes the account.
  if (reading.resetsAtMs !== null && reading.resetsAtMs <= now) {
    return { usedPercent: null, state: "reset_pending_reading", ...base };
  }
  return { usedPercent: Math.max(0, Math.min(100, reading.used)), state: "reported", ...base };
}

function accountQuota(db, connectionId, now) {
  const cache = readQuotaCache(db, connectionId);
  const cacheFetchedAtMs = parseTime(cache?.fetchedAt);
  const readings = {};
  for (const [name, key] of Object.entries(WINDOW_KEYS)) {
    readings[name] = windowReading(
      cache,
      cacheFetchedAtMs,
      latestSnapshot(db, connectionId, key),
      key
    );
  }
  const windows = {
    fiveHour: quotaWindow(readings.fiveHour, now),
    weekly: quotaWindow(readings.weekly, now),
  };
  const capturedTimes = [
    cacheFetchedAtMs,
    readings.fiveHour?.capturedAtMs,
    readings.weekly?.capturedAtMs,
  ].filter((ms) => typeof ms === "number");
  const fetchedAtMs = capturedTimes.length ? Math.max(...capturedTimes) : null;
  const anyWindow = windows.fiveHour !== null || windows.weekly !== null;
  return {
    status:
      !anyWindow || fetchedAtMs === null
        ? "unavailable"
        : now - fetchedAtMs <= QUOTA_FRESH_MS
          ? "fresh"
          : "stale",
    fetchedAt: iso(fetchedAtMs),
    plan: typeof cache?.plan === "string" ? cache.plan : null,
    windows,
    source: "anthropic:/api/oauth/usage (subscription quota) read by Omni Route",
  };
}

function accountState(row, now) {
  const limitedUntil = parseTime(row.rate_limited_until);
  if (!row.is_active) return { state: "inactive", until: null };
  if (row.test_status === "expired" || row.test_status === "unavailable") {
    return { state: row.test_status, until: null };
  }
  if (limitedUntil !== null && limitedUntil > now)
    return { state: "cooldown", until: iso(limitedUntil) };
  return { state: "active", until: null };
}

function latestServed(db) {
  return db
    .prepare(
      `SELECT timestamp, requested_model, model, connection_id, account
         FROM call_logs
        WHERE provider = ? AND status BETWEEN 200 AND 299 AND connection_id IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1`
    )
    .get(PROVIDER);
}

function inUse(db, now) {
  return db
    .prepare(
      `SELECT connection_id, COUNT(*) AS requests, MAX(timestamp) AS last_at
         FROM call_logs
        WHERE provider = ? AND status BETWEEN 200 AND 299 AND timestamp >= ?
          AND connection_id IS NOT NULL
        GROUP BY connection_id ORDER BY last_at DESC`
    )
    .all(PROVIDER, iso(now - IN_USE_WINDOW_MS))
    .map((row) => ({
      connectionId: row.connection_id,
      shortId: shortId(row.connection_id),
      requests: Number(row.requests),
      lastAt: row.last_at,
    }));
}

function lastServedByConnection(db) {
  const rows = db
    .prepare(
      `SELECT connection_id, MAX(timestamp) AS last_at
         FROM call_logs
        WHERE provider = ? AND status BETWEEN 200 AND 299 AND connection_id IS NOT NULL
        GROUP BY connection_id`
    )
    .all(PROVIDER);
  return new Map(rows.map((row) => [row.connection_id, row.last_at]));
}

function lastErrorByConnection(db, now) {
  const rows = db
    .prepare(
      `SELECT c.connection_id, c.timestamp, c.status, c.error_type, c.error_summary, c.model
         FROM call_logs c
         JOIN (SELECT connection_id, MAX(timestamp) AS ts FROM call_logs
                WHERE provider = ? AND status >= 400 AND status != 499 AND timestamp >= ?
                GROUP BY connection_id) l
           ON l.connection_id = c.connection_id AND l.ts = c.timestamp
        WHERE c.provider = ?`
    )
    .all(PROVIDER, iso(now - 24 * 60 * 60_000), PROVIDER);
  return new Map(
    rows.map((row) => [
      row.connection_id,
      {
        at: row.timestamp,
        status: Number(row.status),
        type: row.error_type ?? null,
        reason: sanitizeReason(row.error_summary),
        model: stripProviderPrefix(row.model),
      },
    ])
  );
}

/**
 * Account switches: attempts of one client request share a correlation id, so a request that
 * moved from one account to another left a failed row on the first and a later row on the next.
 */
function switches(db, now) {
  const rows = db
    .prepare(
      `SELECT c.correlation_id, c.timestamp, c.status, c.connection_id, c.account,
              c.requested_model, c.model, c.error_type, c.error_summary
         FROM call_logs c
         JOIN (SELECT correlation_id FROM call_logs
                WHERE provider = ? AND correlation_id IS NOT NULL AND timestamp >= ?
                GROUP BY correlation_id HAVING COUNT(DISTINCT connection_id) > 1) m
           ON m.correlation_id = c.correlation_id
        WHERE c.provider = ?
        ORDER BY c.correlation_id, c.timestamp`
    )
    .all(PROVIDER, iso(now - SWITCH_LOOKBACK_MS), PROVIDER);

  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const next = rows[i];
    if (prev.correlation_id !== next.correlation_id) continue;
    if (prev.connection_id === next.connection_id) continue;
    if (prev.status >= 200 && prev.status < 300) continue;
    events.push({
      at: next.timestamp,
      correlationId: next.correlation_id,
      from: {
        connectionId: prev.connection_id,
        shortId: shortId(prev.connection_id),
        email: prev.account ?? null,
      },
      to: {
        connectionId: next.connection_id,
        shortId: shortId(next.connection_id),
        email: next.account ?? null,
      },
      reason: {
        status: Number(prev.status),
        type: prev.error_type ?? null,
        summary: sanitizeReason(prev.error_summary),
      },
      requestedModel: stripProviderPrefix(prev.requested_model),
      effectiveModel: stripProviderPrefix(next.model),
      outcome: next.status >= 200 && next.status < 300 ? "served" : "failed",
      outcomeStatus: Number(next.status),
      source: "omniroute:call_logs",
    });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, MAX_SWITCHES);
}

/** `authorized` lists the connection ids the operator approved for the Claude pool. */
export function buildUsageReport(db, { now = Date.now(), authorized = [], gateway = {} } = {}) {
  const connections = db
    .prepare(
      `SELECT id, email, name, display_name, priority, is_active, test_status,
              rate_limited_until, last_error_type
         FROM provider_connections WHERE provider = ? ORDER BY priority, id`
    )
    .all(PROVIDER);

  const authorizedSet = new Set(authorized);
  const served = latestServed(db);
  const active = inUse(db, now);
  const activeIds = new Set(active.map((entry) => entry.connectionId));
  const lastServed = lastServedByConnection(db);
  const lastErrors = lastErrorByConnection(db, now);

  const accounts = connections.map((row) => {
    const { state, until } = accountState(row, now);
    return {
      connectionId: row.id,
      shortId: shortId(row.id),
      email: row.email ?? null,
      emailSource: row.email ? "omniroute:provider_connections (OAuth)" : null,
      priority: row.priority ?? null,
      authorized: authorizedSet.has(row.id),
      state,
      stateUntil: until,
      inUse: activeIds.has(row.id),
      servedLatest: served?.connection_id === row.id,
      lastServedAt: lastServed.get(row.id) ?? null,
      lastError: lastErrors.get(row.id) ?? null,
      quota: accountQuota(db, row.id, now),
    };
  });

  const current = served
    ? {
        connectionId: served.connection_id,
        shortId: shortId(served.connection_id),
        email: served.account ?? null,
        emailConfirmed:
          served.account != null &&
          connections.some((c) => c.id === served.connection_id && c.email === served.account),
        requestedModel: stripProviderPrefix(served.requested_model),
        effectiveModel: stripProviderPrefix(served.model),
        at: served.timestamp,
        source: "omniroute:call_logs",
      }
    : null;

  const history = switches(db, now);
  return {
    schema: SCHEMA,
    generatedAt: iso(now),
    gateway: { name: "Omni Route", ...gateway },
    pool: {
      strategy: "priority",
      sameModelFirst: true,
      authorized: [...authorizedSet].map(shortId),
    },
    current,
    inUse: active,
    accounts,
    lastSwitch: history[0] ?? null,
    switches: history,
    thresholds: { quotaFreshMs: QUOTA_FRESH_MS, inUseWindowMs: IN_USE_WINDOW_MS },
  };
}
