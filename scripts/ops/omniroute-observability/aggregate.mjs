// Omni Route observability: builds the account-usage report from Omni Route's own records.
// Read-only. Selects an explicit allowlist of columns; no credential column is ever read.
// Every text value taken from the database is validated against the shape it is expected to
// have, or redacted and bounded when it is free text, before it reaches the report.

export const SCHEMA = "omni-route-usage/v1";
export const PROVIDER = "claude";

const QUOTA_FRESH_MS = 10 * 60_000;
const IN_USE_WINDOW_MS = 5 * 60_000;
const SWITCH_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_SWITCHES = 20;
const EPISODE_GAP_MS = 30 * 60_000;
const MAX_EPISODES = 6;
const MAX_REASON_LENGTH = 160;

const WINDOW_KEYS = { fiveHour: "session (5h)", weekly: "weekly (7d)" };
// Order matters: a scheme with its credential is replaced as a whole before its parts.
// Credentials by their recognizable form, which no model name or e-mail address takes.
const CREDENTIAL_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\boma_[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Assignments such as `token=…`, `api-key: …`, `"secret":"…"`.
  /\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session)\b["']?\s*[:=]\s*["']?[^\s"',;}]+/gi,
];
const HEX_RUN = /[0-9a-f]{24,}/gi;
const SECRET_PATTERNS = [
  ...CREDENTIAL_PATTERNS,
  // In free text, also any other long opaque run of key-like characters.
  /[A-Za-z0-9_\-+/=.~]{32,}/g,
  HEX_RUN,
];

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ERROR_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PLAN_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const EMAIL_RE = /^[^\s@"'<>]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * SQL condition matching ID_RE over the whole stored value, so a row whose id has another shape
 * never takes part in ordering, grouping or limits. SQLite's length() and GLOB stop at a NUL
 * byte and accept blobs, so the value must be text and its bytes are measured and searched.
 */
function validIdSql(column) {
  return `(typeof(${column}) = 'text'
           AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 64
           AND instr(CAST(${column} AS BLOB), x'00') = 0
           AND ${column} NOT GLOB '*[^A-Za-z0-9-]*')`;
}
const CONNECTION_OK = validIdSql("connection_id");
const C_CONNECTION_OK = validIdSql("c.connection_id");

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

// Omni Route writes ISO 8601 timestamps. Anything else is not a time: Date.parse alone accepts
// strings such as "x 5" as dates.
const ISO_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function parseTime(value) {
  if (typeof value !== "string" || !ISO_TIME_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A timestamp from the database, re-emitted in ISO form, or null when it is not one. */
function isoOf(value) {
  return iso(parseTime(value));
}

function matching(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : null;
}

/** `text` with every credential in a recognizable form replaced by "[redacted]". */
export function redactCredentials(text) {
  let out = text;
  for (const pattern of [...CREDENTIAL_PATTERNS, HEX_RUN]) out = out.replace(pattern, "[redacted]");
  return out;
}

function model(value) {
  const name = matching(value, MODEL_RE);
  // A name that holds a credential is no model name: it is dropped, not shown redacted.
  if (name === null || redactCredentials(name) !== name) return null;
  return name.startsWith(`${PROVIDER}/`) ? name.slice(PROVIDER.length + 1) : name;
}

function percent(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sanitizeReason(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  // Control characters are flattened first so a pattern cannot be split across lines.
  let out = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > MAX_REASON_LENGTH ? `${out.slice(0, MAX_REASON_LENGTH - 3)}…` : out;
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

/**
 * A cached entry counts as a complete vendor reading only when it has a fetch time and a quota
 * table with at least one valid window. An entry without quotas, in another format or with no
 * valid window is no evidence about any window.
 */
function completeCacheReading(cache) {
  const fetchedAtMs = parseTime(cache?.fetchedAt);
  const quotas = cache?.quotas;
  if (fetchedAtMs === null || !quotas || typeof quotas !== "object" || Array.isArray(quotas)) {
    return null;
  }
  const hasWindow = Object.values(quotas).some((quota) => percent(quota?.used) !== null);
  return hasWindow ? { fetchedAtMs, quotas } : null;
}

/** The newest snapshot of a window that holds a valid reading; invalid rows are skipped. */
function latestSnapshot(db, connectionId, windowKey) {
  const rows = db
    .prepare(
      `SELECT remaining_percentage, next_reset_at, created_at FROM quota_snapshots
        WHERE provider = ? AND connection_id = ? AND window_key = ?
          AND typeof(remaining_percentage) IN ('integer', 'real')
          AND typeof(created_at) = 'text'
        ORDER BY created_at DESC, id DESC`
    )
    .iterate(PROVIDER, connectionId, windowKey);
  for (const row of rows) {
    if (percent(row.remaining_percentage) !== null && parseTime(row.created_at) !== null) {
      return row;
    }
  }
  return null;
}

/**
 * Omni Route keeps two records of the same vendor reading: the Provider Limits cache, stamped
 * with its fetch time, and quota snapshots, written by the background refresh only when a value
 * changes. The newer of the two is the latest confirmed reading of that window.
 */
function windowReading(reading, snapshot, windowKey) {
  // Omni Route writes a window only when the vendor reported it, so an absent key is an
  // omission. A key that is present but holds no valid percentage says nothing about the window.
  const omitted = reading !== null && !Object.hasOwn(reading.quotas, windowKey);
  const cached = reading?.quotas?.[windowKey];
  const cachedUsed = percent(cached?.used);
  const fromCache =
    reading && cachedUsed !== null
      ? {
          used: cachedUsed,
          resetsAtMs: parseTime(cached.resetAt),
          capturedAtMs: reading.fetchedAtMs,
          source: "omniroute:providerLimitsCache",
        }
      : null;
  const snapshotAtMs = parseTime(snapshot?.created_at);
  const remaining = percent(snapshot?.remaining_percentage);
  const fromSnapshot =
    remaining !== null && snapshotAtMs !== null
      ? {
          used: 100 - remaining,
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
  if (fromSnapshot && omitted && reading.fetchedAtMs > fromSnapshot.capturedAtMs) {
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
  const reading = completeCacheReading(cache);
  const readings = {};
  for (const [name, key] of Object.entries(WINDOW_KEYS)) {
    readings[name] = windowReading(reading, latestSnapshot(db, connectionId, key), key);
  }
  const windows = {
    fiveHour: quotaWindow(readings.fiveHour, now),
    weekly: quotaWindow(readings.weekly, now),
  };
  const capturedTimes = [
    reading?.fetchedAtMs,
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
    plan: matching(cache?.plan, PLAN_RE),
    windows,
    source: "anthropic:/api/oauth/usage (subscription quota) read by Omni Route",
  };
}

// Statuses that Omni Route's account selection treats as terminal until an operator acts
// (isTerminalConnectionStatus in src/sse/services/auth.ts).
const TERMINAL_STATUSES = new Set(["expired", "banned", "credits_exhausted"]);

/**
 * The account's eligibility as the gateway's selector sees it: inactive, a terminal status, a
 * cooldown that has not ended, or eligible. A cooldown that has ended no longer excludes the
 * account even while its stored status still reads `unavailable`; that status is reported as
 * `testStatus` beside the state.
 */
function accountState(row, now) {
  const status = typeof row.test_status === "string" ? row.test_status.trim().toLowerCase() : "";
  const limitedUntil = parseTime(row.rate_limited_until);
  if (!row.is_active) return { state: "inactive", until: null };
  if (TERMINAL_STATUSES.has(status)) return { state: status, until: null };
  if (limitedUntil !== null && limitedUntil > now) {
    return { state: "cooldown", until: iso(limitedUntil) };
  }
  return { state: "active", until: null };
}

const TERMINAL_MODEL = "gpt-6.2-sol";
const TERMINAL_TARGET = `codex/${TERMINAL_MODEL}`;
const TERMINAL_CODEX = `(provider = 'codex' AND model = '${TERMINAL_MODEL}'
  AND requested_model LIKE 'claude/%' AND request_type = 'claude_terminal_fallback'
  AND correlation_id IS NOT NULL)`;

function latestServed(db) {
  return db
    .prepare(
      `SELECT timestamp, requested_model, model, provider, connection_id, account
         FROM call_logs
        WHERE (provider = ? OR ${TERMINAL_CODEX}) AND status BETWEEN 200 AND 299 AND ${CONNECTION_OK}
        ORDER BY timestamp DESC, rowid DESC LIMIT 1`
    )
    .get(PROVIDER);
}

function inUse(db, now) {
  return db
    .prepare(
      `SELECT connection_id, COUNT(*) AS requests, MAX(timestamp) AS last_at
         FROM call_logs
        WHERE provider = ? AND status BETWEEN 200 AND 299 AND timestamp >= ?
          AND ${CONNECTION_OK}
        GROUP BY connection_id ORDER BY last_at DESC, connection_id`
    )
    .all(PROVIDER, iso(now - IN_USE_WINDOW_MS))
    .map((row) => ({
      connectionId: row.connection_id,
      shortId: shortId(row.connection_id),
      requests: Number(row.requests),
      lastAt: isoOf(row.last_at),
    }));
}

function lastServedByConnection(db) {
  const rows = db
    .prepare(
      `SELECT connection_id, MAX(timestamp) AS last_at
         FROM call_logs
        WHERE provider = ? AND status BETWEEN 200 AND 299 AND ${CONNECTION_OK}
        GROUP BY connection_id`
    )
    .all(PROVIDER);
  return new Map(rows.map((row) => [row.connection_id, isoOf(row.last_at)]));
}

function lastErrorByConnection(db, now) {
  const rows = db
    .prepare(
      `SELECT c.connection_id, c.timestamp, c.status, c.error_type, c.error_summary, c.model
         FROM call_logs c
         JOIN (SELECT connection_id, MAX(timestamp) AS ts FROM call_logs
                WHERE provider = ? AND status >= 400 AND status != 499 AND timestamp >= ?
                  AND ${CONNECTION_OK}
                GROUP BY connection_id) l
           ON l.connection_id = c.connection_id AND l.ts = c.timestamp
        WHERE c.provider = ? AND c.status >= 400 AND c.status != 499
        ORDER BY c.rowid`
    )
    .all(PROVIDER, iso(now - 24 * 60 * 60_000), PROVIDER);
  return new Map(
    rows.map((row) => [
      row.connection_id,
      {
        at: isoOf(row.timestamp),
        status: Number(row.status),
        type: matching(row.error_type, ERROR_TYPE_RE),
        reason: sanitizeReason(row.error_summary),
        model: model(row.model),
      },
    ])
  );
}

/**
 * Account switches: attempts of one client request share a correlation id, so a request that
 * moved from one account to another left a failed row on the first and a later row on the next.
 * Only attempts attributed to an account take part, and only attempts inside the look-back.
 */
function switches(db, now, emailOf) {
  const since = iso(now - SWITCH_LOOKBACK_MS);
  const rows = db
    .prepare(
      `SELECT c.correlation_id, c.timestamp, c.status, c.connection_id,
              c.requested_model, c.model, c.error_type, c.error_summary
         FROM call_logs c
         JOIN (SELECT correlation_id FROM call_logs
                WHERE provider = ? AND correlation_id IS NOT NULL AND ${CONNECTION_OK}
                  AND timestamp >= ?
                GROUP BY correlation_id HAVING COUNT(DISTINCT connection_id) > 1) m
           ON m.correlation_id = c.correlation_id
        WHERE c.provider = ? AND ${C_CONNECTION_OK} AND c.timestamp >= ?
        ORDER BY c.correlation_id, c.timestamp, c.rowid`
    )
    .all(PROVIDER, since, PROVIDER, since);

  const endpoint = (connectionId) => ({
    connectionId,
    shortId: shortId(connectionId),
    email: emailOf(connectionId),
  });
  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const next = rows[i];
    if (prev.correlation_id !== next.correlation_id) continue;
    if (prev.connection_id === next.connection_id) continue;
    if (prev.status >= 200 && prev.status < 300) continue;
    events.push({
      at: isoOf(next.timestamp),
      correlationId: matching(next.correlation_id, ID_RE),
      from: endpoint(prev.connection_id),
      to: endpoint(next.connection_id),
      reason: {
        status: Number(prev.status),
        type: matching(prev.error_type, ERROR_TYPE_RE),
        summary: sanitizeReason(prev.error_summary),
      },
      requestedModel: model(prev.requested_model),
      effectiveModel: model(next.model),
      outcome: next.status >= 200 && next.status < 300 ? "served" : "failed",
      outcomeStatus: Number(next.status),
      source: "omniroute:call_logs",
    });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, MAX_SWITCHES);
}

/**
 * Whether an API key grants the terminal fallback, read from its policy columns only: the
 * checks Omni Route repeats before dispatching to Codex (src/sse/handlers/chat.ts). The grant
 * names its Codex accounts in `allowed_connections`.
 */
function terminalGrants(db, now) {
  const rows = db
    .prepare(
      `SELECT model_access_mode, allowed_models, allowed_connections, is_active, is_banned,
              revoked_at, expires_at
         FROM api_keys`
    )
    .all();
  const parseList = (value) => {
    try {
      const list = typeof value === "string" ? JSON.parse(value) : null;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const grants = [];
  for (const row of rows) {
    // As the gateway reads it, an expiry that is not a date does not end the key.
    const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : NaN;
    if (
      row.is_active !== 1 ||
      row.is_banned !== 0 ||
      row.revoked_at !== null ||
      expiresAtMs <= now ||
      row.model_access_mode !== "restricted" ||
      !parseList(row.allowed_models).includes(TERMINAL_TARGET)
    ) {
      continue;
    }
    grants.push(new Set(parseList(row.allowed_connections).filter((id) => typeof id === "string")));
  }
  return grants;
}

/** Terminal attempts of the look-back grouped into episodes split by a quiet gap. */
function terminalEpisodes(db, now) {
  const rows = db
    .prepare(
      `SELECT timestamp, status, requested_model FROM call_logs
        WHERE ${TERMINAL_CODEX} AND typeof(status) = 'integer' AND timestamp >= ?
        ORDER BY timestamp, rowid`
    )
    .all(iso(now - SWITCH_LOOKBACK_MS));
  const episodes = [];
  let open = null;
  for (const row of rows) {
    const atMs = parseTime(row.timestamp);
    if (atMs === null) continue;
    if (open === null || atMs - open.endMs > EPISODE_GAP_MS) {
      open = { startMs: atMs, endMs: atMs, served: 0, failed: 0, models: new Map() };
      episodes.push(open);
    }
    open.endMs = atMs;
    if (row.status >= 200 && row.status < 300) open.served++;
    else if (row.status !== 499) open.failed++;
    const name = model(row.requested_model);
    if (name !== null) open.models.set(name, (open.models.get(name) ?? 0) + 1);
  }
  return episodes
    .sort((a, b) => b.endMs - a.endMs)
    .slice(0, MAX_EPISODES)
    .map((episode) => {
      // The most frequent requested model; a tie goes to the first name in order.
      let requestedModel = null;
      let count = 0;
      for (const [name, n] of episode.models) {
        if (n > count || (n === count && name < requestedModel)) {
          requestedModel = name;
          count = n;
        }
      }
      return {
        start: iso(episode.startMs),
        end: iso(episode.endMs),
        served: episode.served,
        failed: episode.failed,
        requestedModel,
      };
    });
}

/**
 * The last rung of the fallback chain: Codex's GPT-6.2 Sol, which serves a Claude request only
 * through a restricted key that grants it. The account shown is the one that served the latest
 * terminal attempt or, before any, the single active Codex account a grant names.
 */
function terminalStatus(db, now, served) {
  const status = {
    model: TERMINAL_MODEL,
    connectionId: null,
    shortId: null,
    email: null,
    enabled: null,
    state: "unavailable",
    lastServedAt: null,
    episodes: null,
  };
  try {
    const codex = db
      .prepare(
        `SELECT id, email, is_active, test_status, rate_limited_until
           FROM provider_connections WHERE provider = 'codex' ORDER BY id`
      )
      .all()
      .filter((row) => matching(row.id, ID_RE) !== null);
    let grants = null;
    try {
      grants = terminalGrants(db, now);
    } catch {
      // A build without these columns: the grant cannot be read.
    }
    const last = db
      .prepare(
        `SELECT timestamp, connection_id FROM call_logs
          WHERE ${TERMINAL_CODEX} AND status BETWEEN 200 AND 299 AND ${CONNECTION_OK}
          ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      )
      .get();
    status.lastServedAt = isoOf(last?.timestamp);
    let account = codex.find((row) => row.id === last?.connection_id) ?? null;
    if (account === null && grants !== null) {
      const covered = codex.filter(
        (row) => row.is_active && grants.some((grant) => grant.has(row.id))
      );
      if (covered.length === 1) account = covered[0];
    }
    if (account !== null) {
      status.connectionId = account.id;
      status.shortId = shortId(account.id);
      status.email = matching(account.email, EMAIL_RE);
    }
    // Before any account can be named, any grant of a Codex account enables the rung.
    const candidates = account !== null ? [account] : codex;
    if (grants !== null) {
      status.enabled = grants.some((grant) => candidates.some((row) => grant.has(row.id)));
    }
    status.episodes = terminalEpisodes(db, now);
    if (served?.provider === "codex" && served.model === TERMINAL_MODEL) {
      status.state = "serving";
    } else if (
      status.enabled === true &&
      account &&
      accountState(account, now).state === "active"
    ) {
      status.state = "ready";
    } else if (status.enabled === false) {
      status.state = "off";
    }
  } catch {
    // Never a reason to lose the rest of the report.
  }
  return status;
}

/** `authorized` lists the connection ids the operator approved for the Claude pool. */
export function buildUsageReport(db, { now = Date.now(), authorized = [], gateway = {} } = {}) {
  const connections = db
    .prepare(
      `SELECT id, email, priority, is_active, test_status, rate_limited_until
         FROM provider_connections WHERE provider = ? ORDER BY priority, id`
    )
    .all(PROVIDER)
    .filter((row) => matching(row.id, ID_RE) !== null);

  // The account's e-mail comes from its OAuth connection; `call_logs.account` is only a label
  // that can be a name or a short id, so it is compared, never shown.
  const emails = new Map(connections.map((row) => [row.id, matching(row.email, EMAIL_RE)]));
  const emailOf = (connectionId) => emails.get(connectionId) ?? null;

  const authorizedSet = new Set(authorized);
  const served = latestServed(db);
  if (served?.connection_id && !emails.has(served.connection_id)) {
    const servingAccount = db
      .prepare("SELECT email FROM provider_connections WHERE provider = 'codex' AND id = ?")
      .get(served.connection_id);
    if (servingAccount) emails.set(served.connection_id, matching(servingAccount.email, EMAIL_RE));
  }
  const active = inUse(db, now);
  const activeIds = new Set(active.map((entry) => entry.connectionId));
  const lastServed = lastServedByConnection(db);
  const lastErrors = lastErrorByConnection(db, now);

  const accounts = connections.map((row) => {
    const { state, until } = accountState(row, now);
    const email = emailOf(row.id);
    return {
      connectionId: row.id,
      shortId: shortId(row.id),
      email,
      emailSource: email ? "omniroute:provider_connections (OAuth)" : null,
      priority: Number.isInteger(row.priority) ? row.priority : null,
      authorized: authorizedSet.has(row.id),
      state,
      stateUntil: until,
      testStatus: matching(row.test_status, ERROR_TYPE_RE),
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
        email: emailOf(served.connection_id),
        emailConfirmed:
          emailOf(served.connection_id) !== null &&
          served.account === emailOf(served.connection_id),
        requestedModel: model(served.requested_model),
        effectiveModel: model(served.model),
        at: isoOf(served.timestamp),
        source: "omniroute:call_logs",
      }
    : null;

  const history = switches(db, now, emailOf);
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
    terminal: terminalStatus(db, now, served),
    thresholds: { quotaFreshMs: QUOTA_FRESH_MS, inUseWindowMs: IN_USE_WINDOW_MS },
  };
}
