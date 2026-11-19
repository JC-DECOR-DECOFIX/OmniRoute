// Omni Route observability service.
//
// Every poll reads Omni Route's own records read-only and keeps the latest report in memory.
// It serves that report to authenticated local clients at GET /internal/omni-route/usage and,
// when configured, publishes it to a Happy artifact's data store so Happy Desktop and the Happy
// phone apps can show it through the daemon's own authenticated connection.
//
// With a `refresh` block it also answers the panel's "refresh" button: the panel writes a request
// to the artifact's data store, and the service asks Omni Route to read each authorized account's
// quota again, at most once per minimum interval.
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

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_PORT = 20141;
const DEFAULT_HEARTBEAT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const KV_READ_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const REFRESH_DEFAULTS = {
  baseUrl: "http://127.0.0.1:20128",
  minIntervalMs: 120_000,
  requestPollMs: 2_000,
  timeoutMs: 30_000,
  spacingMs: 1_500,
};
// A request already in the store when the service starts is served only if it is this recent;
// an older one was made while the service was down and its viewer has moved on.
const STARTUP_REQUEST_MAX_AGE_MS = 90_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  const refresh = config.refresh;
  if (!refresh || typeof refresh !== "object" || Array.isArray(refresh)) {
    throw new Error("config.refresh must be an object");
  }
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
    url = new URL(refresh.baseUrl ?? REFRESH_DEFAULTS.baseUrl);
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
    timeoutMs: [5_000, 60_000],
    spacingMs: [0, 10_000],
  };
  for (const [name, [min, max]] of Object.entries(limits)) {
    if (!integerIn(refresh[name] ?? REFRESH_DEFAULTS[name], min, max)) {
      throw new Error(`config.refresh.${name} must be an integer from ${min} to ${max}`);
    }
  }
}

/** The refresh settings with their defaults applied, or null when the block is absent. */
export function refreshSettings(config) {
  if (config.refresh === undefined) return null;
  const merged = { ...REFRESH_DEFAULTS, ...config.refresh };
  return { ...merged, baseUrl: new URL(merged.baseUrl).origin };
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

function putKv({ socketPath, token, artifactId, value, writeId }) {
  const body = JSON.stringify({ value, writeId });
  const path = `/v0/artifacts/${encodeURIComponent(artifactId)}/api/v1/kv/entry?key=${encodeURIComponent(KV_KEY)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: PUBLISH_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode >= 200 && res.statusCode < 300
            ? resolve(res.statusCode)
            : reject(new Error(`happy kv write returned HTTP ${res.statusCode}`))
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("happy kv write timed out")));
    req.on("error", reject);
    req.end(body);
  });
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
 * write is still in flight.
 */
export function createPublishQueue({ publish, payload, onResult = () => {} }) {
  let chain = Promise.resolve();
  return function flush() {
    chain = chain.then(async () => {
      try {
        onResult(null, await publish(payload()));
      } catch (error) {
        onResult(error);
      }
    });
    return chain;
  };
}

/** Reads a response body up to a bound; a longer one ends the request. */
function readBody(res, limit, onDone) {
  const chunks = [];
  let size = 0;
  res.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      res.destroy(new Error("response too large"));
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => onDone(Buffer.concat(chunks).toString("utf8")));
}

/** Reads one entry of the artifact's data store, or null when the key holds no value. */
function getKvEntry({ socketPath, token, artifactId, key }) {
  const path = `/v0/artifacts/${encodeURIComponent(artifactId)}/api/v1/kv/entry?key=${encodeURIComponent(key)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        timeout: KV_READ_TIMEOUT_MS,
      },
      (res) => {
        res.on("error", reject);
        readBody(res, MAX_RESPONSE_BYTES, (text) => {
          if (res.statusCode !== 200) {
            reject(new Error(`happy kv read returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text)?.entry ?? null);
          } catch {
            reject(new Error("happy kv read returned invalid JSON"));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("happy kv read timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Asks Omni Route to read one account's quota from the vendor now (GET /api/usage/:id, which
 * persists the reading). Only the status and the `_stale` markers of the answer are kept; the
 * body is not returned, logged or published.
 */
export function gatewayUsageCall({ baseUrl, token, connectionId, timeoutMs }) {
  const url = new URL(`/api/usage/${encodeURIComponent(connectionId)}`, baseUrl);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = client.request(
      url,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      },
      (res) => {
        res.on("error", () => finish({ kind: "network" }));
        readBody(res, MAX_RESPONSE_BYTES, (text) => {
          const status = res.statusCode;
          if (status < 200 || status >= 300) return finish({ kind: "http", status });
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            // A success without a readable body still says the call was accepted.
          }
          const stale = body?._stale === true;
          const rateLimited =
            stale &&
            typeof body._staleReason === "string" &&
            /\b429\b|rate.?limit|too many requests/i.test(body._staleReason);
          finish({ kind: "ok", stale, rateLimited });
        });
      }
    );
    const timer = setTimeout(() => {
      finish({ kind: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("error", () => finish({ kind: "network" }));
    req.end();
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why an account's quota was not read again, in words the panel shows as they are. */
function refreshReason(result) {
  if (!result) return "não consultada";
  switch (result.kind) {
    case "ok":
      if (result.rateLimited) return "limite de consultas da Anthropic";
      if (result.stale) return "a Anthropic não devolveu a cota";
      return "leitura nova não encontrada no banco";
    case "timeout":
      return "tempo esgotado";
    case "network":
      return "Omni Route inacessível";
    case "http":
      if (result.status === 409) return "em uso exclusivo";
      if (result.status === 429) return "limite de consultas da Anthropic";
      if (result.status === 401 || result.status === 403) return "credencial do painel recusada";
      if (result.status === 404) return "conta não encontrada no Omni Route";
      return `Omni Route respondeu HTTP ${result.status}`;
    default:
      return "falha desconhecida";
  }
}

function resultKind(result) {
  if (!result) return null;
  if (result.kind === "http") {
    return result.status === 401 || result.status === 403
      ? "gateway_auth_failed"
      : `gateway_http_${result.status}`;
  }
  if (result.kind === "network") return "gateway_unreachable";
  if (result.kind === "timeout") return "gateway_timeout";
  return null;
}

/** The cause shared by every failed call, when there is one. */
function commonError(results) {
  const kinds = new Set(results.map(resultKind));
  return kinds.size === 1 ? [...kinds][0] : null;
}

/**
 * Serves refresh requests from the panel. A request is a data-store entry whose version is newer
 * than the last one seen; it is served at most once per `minIntervalMs`, one refresh at a time.
 * Every change of state is published through `onChange` before the next step starts.
 */
export function createRefresher({
  observer,
  connections,
  readToken,
  callGateway,
  minIntervalMs = REFRESH_DEFAULTS.minIntervalMs,
  spacingMs = REFRESH_DEFAULTS.spacingMs,
  timeoutMs = REFRESH_DEFAULTS.timeoutMs,
  onChange = async () => {},
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let primed = false;
  let lastSeen = null;
  let last = null;
  let nextAllowedAtMs = null;
  let running = null;
  let pending = null;

  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

  function state() {
    return { minIntervalMs, nextAllowedAt: iso(nextAllowedAtMs), last };
  }

  async function publish() {
    try {
      await onChange();
    } catch {
      // A failed publish is logged by the queue; the refresh goes on.
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

  async function serve(request) {
    const startedAtMs = now();
    const base = {
      requestVersion: request.version,
      requestedAt: iso(request.updatedAt),
    };
    if (nextAllowedAtMs !== null && startedAtMs < nextAllowedAtMs) {
      observer.poll();
      last = {
        ...base,
        status: "throttled",
        startedAt: null,
        finishedAt: iso(now()),
        accounts: [],
        error: null,
      };
      log("refresh throttled");
      await publish();
      return;
    }
    const credential = token();
    if (credential === null) {
      last = {
        ...base,
        status: "failed",
        startedAt: null,
        finishedAt: iso(now()),
        accounts: [],
        error: "not_configured",
      };
      log("refresh failed: not_configured");
      await publish();
      return;
    }

    nextAllowedAtMs = startedAtMs + minIntervalMs;
    last = {
      ...base,
      status: "running",
      startedAt: iso(startedAtMs),
      finishedAt: null,
      accounts: [],
      error: null,
    };
    await publish();

    const results = [];
    for (const [index, connectionId] of connections.entries()) {
      if (index > 0) await sleep(spacingMs);
      results.push(await callGateway({ token: credential, connectionId, timeoutMs }));
    }
    observer.poll();
    const report = observer.payload();
    const accounts = connections.map((connectionId, index) => {
      const quota = report.accounts?.find((a) => a.connectionId === connectionId)?.quota;
      const fetchedAtMs = typeof quota?.fetchedAt === "string" ? Date.parse(quota.fetchedAt) : NaN;
      const updated = Number.isFinite(fetchedAtMs) && fetchedAtMs >= startedAtMs;
      return {
        shortId: connectionId.slice(0, 8),
        updated,
        reason: updated ? null : sanitizeReason(refreshReason(results[index])),
      };
    });
    const count = accounts.filter((a) => a.updated).length;
    const status = count === accounts.length ? "done" : count > 0 ? "partial" : "failed";
    const error = status === "failed" ? commonError(results) : null;
    last = { ...last, status, finishedAt: iso(now()), accounts, error };
    log(
      status === "failed"
        ? `refresh failed: ${error ?? "no account updated"}`
        : `refresh ${status} ${count}/${accounts.length}`
    );
    await publish();
  }

  async function drain(request) {
    let next = request;
    while (next) {
      pending = null;
      try {
        await serve(next);
      } catch {
        // An unexpected failure must not leave the refresh marked as running.
        if (last?.requestVersion === next.version && last.status === "running") {
          last = { ...last, status: "failed", finishedAt: iso(now()) };
          await publish();
        }
        log("refresh failed: internal");
      }
      next = pending;
    }
    running = null;
  }

  /** Takes the store's current entry for the request key; `null` when it holds no value. */
  function offer(entry) {
    const version = typeof entry?.version === "string" ? entry.version : null;
    if (version === null || !UUID_RE.test(version)) {
      primed = true;
      return;
    }
    if (lastSeen !== null && version <= lastSeen) return;
    lastSeen = version;
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : null;
    const wasPrimed = primed;
    primed = true;
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

  return { offer, state, idle: () => running ?? Promise.resolve() };
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
  if (refresh && flush) {
    const { socketPath, tokenFile, artifactId } = config.happy;
    refresher = createRefresher({
      observer,
      connections: config.authorizedConnections,
      // Read for each refresh, so a token created or rotated later is picked up.
      readToken: () => readSecretFile(refresh.tokenFile),
      callGateway: ({ token, connectionId, timeoutMs }) =>
        gatewayUsageCall({ baseUrl: refresh.baseUrl, token, connectionId, timeoutMs }),
      minIntervalMs: refresh.minIntervalMs,
      spacingMs: refresh.spacingMs,
      timeoutMs: refresh.timeoutMs,
      onChange: flush,
      log,
    });
    let reading = false;
    let lastReadError = null;
    readRequest = async () => {
      if (reading) return;
      reading = true;
      try {
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

  let lastPollError = null;
  const tick = async () => {
    observer.poll();
    const pollError = observer.payload().observer.lastError;
    if (pollError !== lastPollError)
      log(pollError ? `poll failed: ${pollError}` : "poll recovered");
    lastPollError = pollError;
    if (flush) await flush();
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
