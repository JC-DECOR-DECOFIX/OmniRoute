// Omni Route observability service.
//
// Every poll reads Omni Route's own records read-only and keeps the latest report in memory.
// It serves that report to authenticated local clients at GET /internal/omni-route/usage and,
// when configured, publishes it to a Happy artifact's data store so Happy Desktop and the Happy
// phone apps can show it through the daemon's own authenticated connection.
//
// With a `refresh` block it also answers the panel's "refresh" button: the panel writes a request
// to the artifact's data store, and the service asks Omni Route to run its provider-limits sync
// now, the same one it runs on its own every 70 minutes, at most once per minimum interval.
//
// Usage: node server.mjs /absolute/path/to/config.json

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildUsageReport, sanitizeReason } from "./aggregate.mjs";

export const USAGE_PATH = "/internal/omni-route/usage";
export const KV_KEY = "omni-route/usage";
export const REFRESH_REQUEST_KEY = "omni-route/refresh-request";
export const REFRESH_REQUEST_SCHEMA = "omni-route-refresh-request/v1";
export const PROVIDER_LIMITS_PATH = "/api/usage/provider-limits";

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_PORT = 20141;
const DEFAULT_HEARTBEAT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const KV_READ_TIMEOUT_MS = 10_000;
// A data-store value is at most 256 KiB; its entry wraps it in a little more.
const MAX_RESPONSE_BYTES = 1024 * 1024;

const REFRESH_DEFAULTS = {
  baseUrl: "http://127.0.0.1:20128",
  minIntervalMs: 120_000,
  requestPollMs: 2_000,
  // One call reads every supported provider of the gateway in turn, 1.5 s apart.
  timeoutMs: 60_000,
};
// A request already in the store when the service starts is served only if it is this recent;
// an older one was made while the service was down and its viewer has moved on.
const STARTUP_REQUEST_MAX_AGE_MS = 90_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Agents of their own, so a proxy configured for the process (NODE_USE_ENV_PROXY with
// HTTP_PROXY, which the global agent honors) never receives a request or its credential.
const DIRECT_HTTP = new http.Agent();
const DIRECT_HTTPS = new https.Agent();

/** Same owner-only rule as the continuity client's private configuration. */
export function readPrivateFile(path) {
  const stat = statSync(path);
  if (stat.mode & 0o077 || stat.uid !== process.getuid()) {
    throw new Error(`${path} must belong to this user and have mode 0600`);
  }
  return readFileSync(path, "utf8");
}

function readSecretFile(path) {
  const value = readPrivateFile(path).trim();
  if (!value) throw new Error(`empty secret file: ${path}`);
  return value;
}

export function loadConfig(path) {
  const config = JSON.parse(readPrivateFile(path));
  if (typeof config.dbPath !== "string" || !isAbsolute(config.dbPath)) {
    throw new Error("config.dbPath must be an absolute path");
  }
  if (typeof config.tokenFile !== "string" || !isAbsolute(config.tokenFile)) {
    throw new Error("config.tokenFile must be an absolute path");
  }
  const authorized = config.authorizedConnections ?? [];
  if (!Array.isArray(authorized) || !authorized.every((id) => /^[A-Za-z0-9-]{1,64}$/.test(id))) {
    throw new Error("config.authorizedConnections must be a list of connection ids");
  }
  const gateway = config.gateway ?? {};
  if (
    typeof gateway !== "object" ||
    Array.isArray(gateway) ||
    !Object.values(gateway).every((v) => typeof v === "string" && /^[A-Za-z0-9 ._-]{0,64}$/.test(v))
  ) {
    throw new Error("config.gateway must map names to short labels");
  }
  // TCP on loopback is the only listener: a configurable socket path would be unlinked before
  // binding, and a wrong path could remove a file this service does not own.
  if (config.listen?.socket !== undefined) {
    throw new Error("config.listen.socket is not supported; use config.listen.port");
  }
  const port = config.listen?.port ?? DEFAULT_PORT;
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error("config.listen.port must be a TCP port");
  }
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < 1_000) {
    throw new Error("config.pollIntervalMs must be at least 1000");
  }
  if (config.refresh !== undefined) validateRefresh(config);
  return config;
}

function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The refresh block calls Omni Route with a credential, so it may only point at the gateway on
 * this machine, and it needs the Happy block, through which requests arrive.
 */
function validateRefresh(config) {
  if (!config.refresh || typeof config.refresh !== "object" || Array.isArray(config.refresh)) {
    throw new Error("config.refresh must be an object");
  }
  // The settings are validated as the service will use them, defaults applied: an explicit
  // null is not a default and is refused.
  const refresh = { ...REFRESH_DEFAULTS, ...config.refresh };
  const happy = config.happy ?? {};
  if (
    typeof happy.artifactId !== "string" ||
    typeof happy.socketPath !== "string" ||
    typeof happy.tokenFile !== "string"
  ) {
    throw new Error("config.refresh needs the happy block (socketPath, tokenFile, artifactId)");
  }
  if (!(config.authorizedConnections ?? []).length) {
    throw new Error("config.refresh needs config.authorizedConnections");
  }
  let url;
  try {
    if (typeof refresh.baseUrl !== "string") throw new TypeError("not a string");
    url = new URL(refresh.baseUrl);
  } catch {
    throw new Error("config.refresh.baseUrl must be a URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "config.refresh.baseUrl must be an http(s) loopback origin without credentials"
    );
  }
  if (typeof refresh.tokenFile !== "string" || !isAbsolute(refresh.tokenFile)) {
    throw new Error("config.refresh.tokenFile must be an absolute path");
  }
  const limits = {
    minIntervalMs: [60_000, 24 * 60 * 60_000],
    requestPollMs: [500, 10_000],
    timeoutMs: [5_000, 120_000],
  };
  for (const [name, [min, max]] of Object.entries(limits)) {
    if (!integerIn(refresh[name], min, max)) {
      throw new Error(`config.refresh.${name} must be an integer from ${min} to ${max}`);
    }
  }
}

/** The refresh settings with their defaults applied, or null when the block is absent. */
export function refreshSettings(config) {
  if (config.refresh === undefined) return null;
  const merged = { ...REFRESH_DEFAULTS, ...config.refresh };
  const url = new URL(merged.baseUrl);
  // A name is resolved by the system and could point elsewhere; the loopback address cannot.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  // Only the known settings; a `spacingMs` left from the per-account version is not used, since
  // the sync spaces its own reads.
  const { minIntervalMs, requestPollMs, timeoutMs, tokenFile } = merged;
  return { baseUrl: url.origin, tokenFile, minIntervalMs, requestPollMs, timeoutMs };
}

function sameSecret(provided, expected) {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Fixed SQLite result texts (sqlite3_errstr) that explain a failed read; nothing else is shown.
const SQLITE_RESULTS = new Set([
  "database is locked",
  "database table is locked",
  "unable to open database file",
  "disk I/O error",
  "database disk image is malformed",
  "file is not a database",
  "out of memory",
  "SQL logic error",
]);

/**
 * What the report says about a failed read: the error's code and, for SQLite, its fixed result
 * text such as "database is locked". The message itself is never served, since it can quote
 * paths or values.
 */
export function readFailure(error) {
  const code =
    typeof error?.code === "string" && /^(ERR_[A-Z0-9_]{1,60}|E[A-Z]{2,20})$/.test(error.code)
      ? error.code
      : "read_failed";
  const detail =
    typeof error?.errstr === "string" && SQLITE_RESULTS.has(error.errstr) ? error.errstr : null;
  return detail ? `${code}: ${detail}` : code;
}

/**
 * Holds the latest report and how current it is. Pure apart from the injected reader.
 * `refreshState` supplies the payload's `refresh` field; it is null when refresh is not set up.
 */
export function createObserver({
  read,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  refreshState = () => null,
}) {
  let report = null;
  let lastSuccessAt = null;
  let lastError = null;

  function poll() {
    try {
      report = read(now());
      lastSuccessAt = now();
      lastError = null;
    } catch (error) {
      // Keep the last good report; the payload says it is stale and why.
      lastError = readFailure(error);
    }
  }

  function payload() {
    const at = now();
    const status =
      lastSuccessAt === null
        ? "unavailable"
        : lastError === null && at - lastSuccessAt <= 2 * pollMs
          ? "fresh"
          : "stale";
    return {
      ...(report ?? { schema: "omni-route-usage/v1", generatedAt: null }),
      refresh: refreshState(),
      observer: {
        status,
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
        lastError,
        pollIntervalMs: pollMs,
        servedAt: new Date(at).toISOString(),
      },
    };
  }

  return { poll, payload, hasReport: () => report !== null };
}

export function sqliteReader({ dbPath, authorized, gateway }) {
  return (now) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return buildUsageReport(db, { now, authorized, gateway });
    } finally {
      db.close();
    }
  };
}

export function createUsageServer({ observer, token }) {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    // A request target such as "//" is not a valid URL; answer it instead of throwing.
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(400, { error: "bad_request" });
    }
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(200, { ok: true, status: observer.payload().observer.status });
      }
      if (url.pathname !== USAGE_PATH) return send(404, { error: "not_found" });
      if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
      const header = req.headers.authorization ?? "";
      const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      if (!provided || !sameSecret(provided, token)) return send(401, { error: "unauthorized" });
      const body = observer.payload();
      return send(observer.hasReport() ? 200 : 503, body);
    } catch {
      // No request may end the process and lose the report held in memory.
      if (!res.headersSent) return send(500, { error: "internal_error" });
      return res.destroy();
    }
  });
}

/** Content identity of a report, ignoring the fields that change on every poll. */
export function reportFingerprint(payload) {
  const { generatedAt, observer, ...rest } = payload;
  return createHash("sha256")
    .update(JSON.stringify({ ...rest, status: observer?.status, lastError: observer?.lastError }))
    .digest("hex");
}

/**
 * One HTTP exchange with a deadline for the whole of it and a bounded response body. Resolves
 * with the status and the body text. Rejects, with `kind` "timeout" or "network", when the
 * deadline passes, the body is too large, or the connection fails or closes before the response
 * ends. Error messages carry only the label and a system error code, never a path or a body.
 */
export function exchange({ client = http, url, options, body, deadlineMs, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const fail = (kind, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      reject(Object.assign(new Error(`${label} ${detail}`), { kind }));
    };
    const failed = (error) => {
      const code = typeof error?.code === "string" && /^E[A-Z_]{2,30}$/.test(error.code);
      fail("network", code ? `failed: ${error.code}` : "failed");
    };
    const timer = setTimeout(() => fail("timeout", "timed out"), deadlineMs);
    const direct = { ...options, agent: client === https ? DIRECT_HTTPS : DIRECT_HTTP };
    try {
      req = url ? client.request(url, direct) : client.request(direct);
    } catch (error) {
      // Invalid options throw before a request exists; they end the same way as a failed one.
      failed(error);
      return;
    }
    req.on("response", (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) fail("network", "response too large");
        else chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", failed);
      res.on("close", () => {
        if (!res.complete) fail("network", "response interrupted");
      });
    });
    req.on("error", failed);
    req.end(body);
  });
}

function kvPath(artifactId, key) {
  return `/v0/artifacts/${encodeURIComponent(artifactId)}/api/v1/kv/entry?key=${encodeURIComponent(key)}`;
}

async function putKv({ socketPath, token, artifactId, value, writeId }) {
  const body = JSON.stringify({ value, writeId });
  const { status } = await exchange({
    options: {
      socketPath,
      path: kvPath(artifactId, KV_KEY),
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    },
    body,
    deadlineMs: PUBLISH_TIMEOUT_MS,
    label: "happy kv write",
  });
  if (status < 200 || status >= 300) throw new Error(`happy kv write returned HTTP ${status}`);
  return status;
}

/** Publishes when the report changes, and at least once per heartbeat so viewers see liveness. */
export function createPublisher({ write, heartbeatMs = DEFAULT_HEARTBEAT_MS, now = Date.now }) {
  let lastFingerprint = null;
  let lastWriteAt = 0;
  let sequence = 0;
  let inFlight = false;
  return async function publish(payload) {
    if (inFlight) return "busy";
    const fingerprint = reportFingerprint(payload);
    if (fingerprint === lastFingerprint && now() - lastWriteAt < heartbeatMs) return "unchanged";
    inFlight = true;
    try {
      sequence += 1;
      await write({ value: payload, writeId: `obs-${now()}-${sequence}` });
      lastFingerprint = fingerprint;
      lastWriteAt = now();
      return "written";
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Runs publishes one after another, each with the payload as it is when its turn comes, so a
 * refresh's "running" and its result are both written, in that order, even while a tick's
 * write is still in flight. Each call's promise settles with its own publish, so a caller can
 * tell whether its state went out; a failure does not stop the publishes queued after it.
 */
export function createPublishQueue({ publish, payload, onResult = () => {} }) {
  let chain = Promise.resolve();
  return function flush() {
    const run = chain.then(async () => {
      try {
        const result = await publish(payload());
        onResult(null, result);
        return result;
      } catch (error) {
        onResult(error);
        throw error;
      }
    });
    chain = run.catch(() => {});
    return run;
  };
}

/** Calls `fn` unless a call is still pending, in which case its promise is shared. */
export function coalesce(fn) {
  let pending = null;
  return () => {
    pending ??= Promise.resolve()
      .then(fn)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/** Reads one entry of the artifact's data store, or null when the key holds no value. */
async function getKvEntry({ socketPath, token, artifactId, key }) {
  const { status, text } = await exchange({
    options: {
      socketPath,
      path: kvPath(artifactId, key),
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    },
    deadlineMs: KV_READ_TIMEOUT_MS,
    label: "happy kv read",
  });
  if (status !== 200) throw new Error(`happy kv read returned HTTP ${status}`);
  try {
    return JSON.parse(text)?.entry ?? null;
  } catch {
    throw new Error("happy kv read returned invalid JSON");
  }
}

/**
 * What kind of failure the sync recorded for one connection. The sync keeps only the thrown
 * error's message, so the kind is read from the fixed texts Omni Route throws; the text itself
 * is not kept.
 */
export function syncErrorKind(message) {
  const text = typeof message === "string" ? message.slice(0, 2_000) : "";
  if (/exclusive lease/i.test(text)) return "lease";
  if (
    /re-?authori[sz]e|re-?authenticate|credential|unauthori[sz]ed|forbidden|access denied|invalid_grant|token expired|\b40[13]\b/i.test(
      text
    )
  ) {
    return "auth";
  }
  if (
    /fetch failed|network|proxy|socket|timed? ?out|\bE(?:CONN[A-Z]+|TIMEDOUT|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)\b|UND_ERR/i.test(
      text
    )
  ) {
    return "network";
  }
  return "other";
}

/**
 * Asks Omni Route to run its provider-limits sync now (POST /api/usage/provider-limits, the
 * dashboard's "refresh all"). The sync reads every active supported connection of the gateway,
 * OAuth ones one at a time 1.5 s apart, and stores each reading in `providerLimitsCache`. Only
 * the status and, for the given connections, the kind of error the sync recorded are kept; the
 * body, which carries the cached limits of every provider, is not returned, logged or published.
 */
export async function gatewaySyncCall({ baseUrl, token, timeoutMs, connections = [] }) {
  const url = new URL(PROVIDER_LIMITS_PATH, baseUrl);
  let response;
  try {
    response = await exchange({
      client: url.protocol === "https:" ? https : http,
      url,
      options: {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": "0",
        },
      },
      deadlineMs: timeoutMs,
      label: "omni route sync",
    });
  } catch (error) {
    return { kind: error.kind === "timeout" ? "timeout" : "network" };
  }
  const { status, text } = response;
  if (status < 200 || status >= 300) return { kind: "http", status };
  let recorded = null;
  try {
    recorded = JSON.parse(text)?.errors;
  } catch {
    // A success without a readable body still says the sync ran.
  }
  const errors = {};
  if (recorded && typeof recorded === "object" && !Array.isArray(recorded)) {
    for (const id of connections) {
      if (Object.hasOwn(recorded, id)) errors[id] = syncErrorKind(recorded[id]);
    }
  }
  return { kind: "ok", errors };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The sync only reads active connections; an exclusive lease also keeps one out, but leases are
// not in the tables this service reads, so such an account gets the probable-limit text.
const NOT_IN_SYNC = "não incluída no sync do Omni Route";
const PROBABLE_LIMIT = "a Anthropic não devolveu a cota (provável limite de consultas)";

/** Why an account's quota was not read again, in words the panel shows as they are. */
function refreshReason(result, connectionId, account) {
  switch (result.kind) {
    case "ok":
      switch (result.errors?.[connectionId]) {
        case "lease":
          return "em uso exclusivo";
        case "auth":
          return "credencial da conta recusada";
        case "network":
          return "Anthropic inacessível";
        case "other":
          return PROBABLE_LIMIT;
        default:
          // No error recorded: the sync skipped the account, or Anthropic answered without
          // quotas and Omni Route kept the previous reading. The installed build does not say
          // why; a 429 from Anthropic's usage endpoint is the usual cause.
          return !account || account.state === "inactive" ? NOT_IN_SYNC : PROBABLE_LIMIT;
      }
    case "timeout":
      return "tempo esgotado";
    case "network":
      return "Omni Route inacessível";
    case "http":
      if (result.status === 401 || result.status === 403) return "credencial do painel recusada";
      return `Omni Route respondeu HTTP ${result.status}`;
    default:
      return "falha desconhecida";
  }
}

/** The cause of a sync call that failed as a whole; null when the sync ran. */
function callError(result) {
  if (result.kind === "http") {
    return result.status === 401 || result.status === 403
      ? "gateway_auth_failed"
      : `gateway_http_${result.status}`;
  }
  if (result.kind === "network") return "gateway_unreachable";
  if (result.kind === "timeout") return "gateway_timeout";
  return null;
}

/**
 * Serves refresh requests from the panel. A request is a data-store entry whose version is newer
 * than the last one seen; it is served at most once per `minIntervalMs`, one refresh at a time.
 * Every change of state is published through `onChange`; the gateway is called only after the
 * "running" state has been written, so the panel never misses a refresh that is under way.
 * Requests seen while a refresh runs are answered as throttled when it ends, whatever the time:
 * the panel shows only the newest request, so only the newest of them is answered.
 */
export function createRefresher({
  observer,
  connections,
  readToken,
  callGateway,
  minIntervalMs = REFRESH_DEFAULTS.minIntervalMs,
  timeoutMs = REFRESH_DEFAULTS.timeoutMs,
  onChange = async () => {},
  log = () => {},
  now = Date.now,
}) {
  let primed = false;
  let lastSeen = null;
  let last = null;
  let nextAllowedAtMs = null;
  let running = null;
  let pending = null;
  // When the last refresh that called the gateway ended; a request made before then was made
  // while it ran, even if it is first seen afterwards.
  let lastRefreshEndMs = null;

  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

  function state() {
    return { minIntervalMs, nextAllowedAt: iso(nextAllowedAtMs), last };
  }

  async function publish() {
    try {
      await onChange();
      return true;
    } catch {
      // The queue logs the failure; the state stays in memory for the next publish.
      return false;
    }
  }

  function token() {
    try {
      const value = readToken();
      return /^[\x21-\x7e]{1,4096}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Answers one request; true when it called the gateway. */
  async function serve(request, throttle) {
    const startedAtMs = now();
    const base = {
      requestVersion: request.version,
      requestedAt: iso(request.updatedAt),
    };
    const answer = (fields) => {
      last = { ...base, startedAt: null, finishedAt: iso(now()), accounts: [], ...fields };
    };
    const madeDuringRefresh = lastRefreshEndMs !== null && request.updatedAt <= lastRefreshEndMs;
    const inInterval = nextAllowedAtMs !== null && startedAtMs < nextAllowedAtMs;
    if (throttle || madeDuringRefresh || inInterval) {
      observer.poll();
      answer({ status: "throttled", error: null });
      log("refresh throttled");
      await publish();
      return false;
    }
    const credential = token();
    if (credential === null) {
      answer({ status: "failed", error: "not_configured" });
      log("refresh failed: not_configured");
      await publish();
      return false;
    }

    const previousNextAllowedAtMs = nextAllowedAtMs;
    nextAllowedAtMs = startedAtMs + minIntervalMs;
    last = {
      ...base,
      status: "running",
      startedAt: iso(startedAtMs),
      finishedAt: null,
      accounts: [],
      error: null,
    };
    if (!(await publish())) {
      // Nothing is read while the panel cannot be told; the request does not use the interval.
      nextAllowedAtMs = previousNextAllowedAtMs;
      answer({ status: "failed", error: null });
      log("refresh failed: publish");
      await publish();
      return false;
    }

    const result = await callGateway({ token: credential, connections, timeoutMs });
    // Giving up on the answer does not stop Omni Route's sync, which goes on reading the
    // remaining providers. The interval starts again at the timeout, so the next sync waits a
    // whole interval after it.
    if (result.kind === "timeout") {
      nextAllowedAtMs = Math.max(nextAllowedAtMs, now() + minIntervalMs);
    }
    observer.poll();
    const report = observer.payload();
    const accounts = connections.map((connectionId) => {
      const account = report.accounts?.find((a) => a.connectionId === connectionId);
      const fetchedAt = account?.quota?.fetchedAt;
      const fetchedAtMs = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : NaN;
      const updated = Number.isFinite(fetchedAtMs) && fetchedAtMs >= startedAtMs;
      return {
        shortId: connectionId.slice(0, 8),
        updated,
        reason: updated ? null : sanitizeReason(refreshReason(result, connectionId, account)),
      };
    });
    const count = accounts.filter((a) => a.updated).length;
    const status = count === accounts.length ? "done" : count > 0 ? "partial" : "failed";
    const error = status === "failed" ? callError(result) : null;
    lastRefreshEndMs = now();
    last = { ...last, status, finishedAt: iso(lastRefreshEndMs), accounts, error };
    log(
      status === "failed"
        ? `refresh failed: ${error ?? "no account updated"}`
        : `refresh ${status} ${count}/${accounts.length}`
    );
    await publish();
    return true;
  }

  async function drain(request) {
    let next = request;
    let refreshed = false;
    while (next) {
      pending = null;
      try {
        refreshed = (await serve(next, refreshed)) || refreshed;
      } catch {
        // An unexpected failure must not leave the refresh marked as running.
        if (last?.requestVersion === next.version && last.status === "running") {
          last = { ...last, status: "failed", finishedAt: iso(now()) };
          await publish();
        }
        refreshed = true;
        lastRefreshEndMs = now();
        log("refresh failed: internal");
      }
      next = pending;
    }
    running = null;
  }

  /** Takes the store's current entry for the request key; `null` when it holds no value. */
  function offer(entry) {
    // Only the first read of the request key after a start applies the age limit, whatever
    // was restored before it.
    const wasPrimed = primed;
    primed = true;
    const version = typeof entry?.version === "string" ? entry.version : null;
    if (version === null || !UUID_RE.test(version)) return;
    if (lastSeen !== null && version <= lastSeen) return;
    lastSeen = version;
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
    if (entry.deleted || entry.value?.schema !== REFRESH_REQUEST_SCHEMA || updatedAt === null) {
      return;
    }
    if (!wasPrimed && now() - updatedAt > STARTUP_REQUEST_MAX_AGE_MS) return;
    log("refresh requested");
    const request = { version, updatedAt };
    if (running) {
      pending = request;
      return;
    }
    running = drain(request);
  }

  /**
   * Takes back the state this service last published, before its first publish after a start,
   * so a restart neither answers a request again nor reopens the interval. The published report
   * lives in a store its viewers can write, so only well-formed values are kept and the interval
   * is never pushed further than one interval from now. A refresh that was running when the
   * service stopped is reported as failed and not repeated.
   */
  function restore(previous) {
    const at = now();
    const prior = previous?.last;
    const version = typeof prior?.requestVersion === "string" ? prior.requestVersion : null;
    if (version === null || !UUID_RE.test(version)) return;
    // A UUIDv7 carries its write time; a version from the future could hide every request.
    if (Number.parseInt(version.slice(0, 8) + version.slice(9, 13), 16) > at) return;
    const time = (value) => {
      const ms = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(ms) && ms <= at + minIntervalMs ? ms : null;
    };
    const status = ["running", "done", "partial", "failed", "throttled"].includes(prior.status)
      ? prior.status
      : null;
    if (status === null) return;
    lastSeen = version;
    const nextMs = time(previous.nextAllowedAt);
    nextAllowedAtMs = nextMs !== null && nextMs > at ? nextMs : null;
    const startedAtMs = time(prior.startedAt);
    const finishedAtMs = time(prior.finishedAt);
    const accounts = Array.isArray(prior.accounts)
      ? prior.accounts
          .filter(
            (a) =>
              typeof a?.shortId === "string" &&
              /^[A-Za-z0-9-]{1,8}$/.test(a.shortId) &&
              typeof a.updated === "boolean"
          )
          .slice(0, 64)
          .map((a) => ({
            shortId: a.shortId,
            updated: a.updated,
            reason: a.updated ? null : sanitizeReason(a.reason),
          }))
      : [];
    const error =
      typeof prior.error === "string" &&
      /^(not_configured|gateway_unreachable|gateway_auth_failed|gateway_timeout|gateway_http_\d{3})$/.test(
        prior.error
      )
        ? prior.error
        : null;
    last = {
      requestVersion: version,
      requestedAt: iso(time(prior.requestedAt)),
      status,
      startedAt: iso(startedAtMs),
      finishedAt: iso(finishedAtMs),
      accounts,
      error,
    };
    if (startedAtMs !== null) lastRefreshEndMs = finishedAtMs ?? at;
    if (status === "running") {
      // The round may have timed out and pushed the interval past what was published; with
      // no way to know, the gateway gets a whole interval from now.
      nextAllowedAtMs = Math.max(nextAllowedAtMs ?? at, at + minIntervalMs);
      last = { ...last, status: "failed", finishedAt: iso(at), error: null };
      lastRefreshEndMs = at;
      log("refresh interrupted by a restart");
    }
  }

  return { offer, state, restore, idle: () => running ?? Promise.resolve() };
}

/**
 * Node prints request options, headers included, on stderr when NODE_DEBUG names its network
 * modules. With any NODE_DEBUG set, the gateway credential is not used at all.
 */
export function debugLogsRequests(env = process.env) {
  return typeof env.NODE_DEBUG === "string" && env.NODE_DEBUG.trim() !== "";
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(configPath) {
  const config = loadConfig(configPath);
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
  const refresh = refreshSettings(config);
  let refresher = null;
  const observer = createObserver({
    read: sqliteReader({
      dbPath: config.dbPath,
      authorized: config.authorizedConnections ?? [],
      gateway: config.gateway ?? {},
    }),
    pollMs,
    refreshState: () => refresher?.state() ?? null,
  });
  const server = createUsageServer({ observer, token: readSecretFile(config.tokenFile) });

  let flush = null;
  if (config.happy?.artifactId) {
    const { socketPath, tokenFile, artifactId } = config.happy;
    const publish = createPublisher({
      // The daemon token is read for each write, so a rotated token is picked up.
      write: ({ value, writeId }) =>
        putKv({ socketPath, token: readSecretFile(tokenFile), artifactId, value, writeId }),
      heartbeatMs: config.happy.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    });
    let lastPublishError = null;
    flush = createPublishQueue({
      publish,
      payload: () => observer.payload(),
      onResult: (error) => {
        if (!error) {
          if (lastPublishError) log("happy publish recovered");
          lastPublishError = null;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastPublishError) log(`happy publish failed: ${message}`);
        lastPublishError = message;
      },
    });
  }

  let readRequest = null;
  let ensureRestored = async () => true;
  if (refresh && flush) {
    const { socketPath, tokenFile, artifactId } = config.happy;
    refresher = createRefresher({
      observer,
      connections: config.authorizedConnections,
      // Read for each refresh, so a token created or rotated later is picked up.
      readToken: () => {
        if (debugLogsRequests()) throw new Error("NODE_DEBUG is set");
        return readSecretFile(refresh.tokenFile);
      },
      callGateway: ({ token, connections, timeoutMs }) =>
        gatewaySyncCall({ baseUrl: refresh.baseUrl, token, connections, timeoutMs }),
      minIntervalMs: refresh.minIntervalMs,
      timeoutMs: refresh.timeoutMs,
      onChange: flush,
      log,
    });
    if (debugLogsRequests()) log("refresh disabled while NODE_DEBUG is set");
    // The state published before a restart must be taken back before this process publishes
    // anything or answers a request. A failed read is retried on every tick and request poll;
    // only a read that succeeds, with or without a previous report, lets either go ahead.
    let restored = false;
    let lastRestoreError = null;
    ensureRestored = coalesce(async () => {
      if (restored) return true;
      try {
        const previous = await getKvEntry({
          socketPath,
          token: readSecretFile(tokenFile),
          artifactId,
          key: KV_KEY,
        });
        refresher.restore(previous?.deleted ? null : previous?.value?.refresh);
        restored = true;
        if (lastRestoreError) log("refresh state restored");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastRestoreError) log(`refresh state not restored: ${message}`);
        lastRestoreError = message;
        return false;
      }
    });
    let reading = false;
    let lastReadError = null;
    readRequest = async () => {
      if (reading) return;
      reading = true;
      try {
        if (!(await ensureRestored())) return;
        const entry = await getKvEntry({
          socketPath,
          token: readSecretFile(tokenFile),
          artifactId,
          key: REFRESH_REQUEST_KEY,
        });
        if (lastReadError) log("refresh request read recovered");
        lastReadError = null;
        refresher.offer(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastReadError) log(`refresh request read failed: ${message}`);
        lastReadError = message;
      } finally {
        reading = false;
      }
    };
  }

  // At most one periodic publish waits in the queue: while the daemon is slow, later ticks
  // join it instead of piling up. It takes the newest report when its turn comes. A failed
  // write is logged by the queue; the next tick or heartbeat tries again.
  const publishTick = flush ? coalesce(() => flush().catch(() => {})) : null;
  let lastPollError = null;
  const tick = async () => {
    observer.poll();
    const pollError = observer.payload().observer.lastError;
    if (pollError !== lastPollError)
      log(pollError ? `poll failed: ${pollError}` : "poll recovered");
    lastPollError = pollError;
    if (publishTick && (await ensureRestored())) await publishTick();
  };
  await tick();
  const timer = setInterval(tick, pollMs);

  let requestTimer = null;
  if (readRequest) {
    await readRequest();
    requestTimer = setInterval(readRequest, refresh.requestPollMs);
  }

  // A port in use or a refused bind ends the process, so the supervisor retries it.
  server.on("error", (error) => {
    log(`fatal: ${error.message}`);
    process.exit(1);
  });
  server.on("listening", () => log(`listening on ${JSON.stringify(server.address())}`));
  // Loopback only: the report names accounts and is not meant for the network.
  server.listen(config.listen?.port ?? DEFAULT_PORT, "127.0.0.1");

  const stop = () => {
    clearInterval(timer);
    clearInterval(requestTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// The installed copy runs through a `current` symlink; Node resolves the module's own URL to the
// real path, so compare against the real path of the entry argument.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
