// Omni Route observability service.
//
// Every poll reads Omni Route's own records read-only and keeps the latest report in memory.
// It serves that report to authenticated local clients at GET /internal/omni-route/usage and,
// when configured, publishes it to a Happy artifact's data store so Happy Desktop and the Happy
// phone apps can show it through the daemon's own authenticated connection.
//
// Usage: node server.mjs /absolute/path/to/config.json

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildUsageReport } from "./aggregate.mjs";

export const USAGE_PATH = "/internal/omni-route/usage";
export const KV_KEY = "omni-route/usage";

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_PORT = 20131;
const DEFAULT_HEARTBEAT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 10_000;

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
  if (config.authorizedConnections !== undefined && !Array.isArray(config.authorizedConnections)) {
    throw new Error("config.authorizedConnections must be a list of connection ids");
  }
  const port = config.listen?.port ?? DEFAULT_PORT;
  if (!config.listen?.socket && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error("config.listen.port must be a TCP port");
  }
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < 1_000) {
    throw new Error("config.pollIntervalMs must be at least 1000");
  }
  return config;
}

function sameSecret(provided, expected) {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Holds the latest report and how current it is. Pure apart from the injected reader. */
export function createObserver({ read, pollMs = DEFAULT_POLL_MS, now = Date.now }) {
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
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  function payload() {
    const at = now();
    const status =
      lastSuccessAt === null ? "unavailable" : at - lastSuccessAt <= 2 * pollMs ? "fresh" : "stale";
    return {
      ...(report ?? { schema: "omni-route-usage/v1", generatedAt: null }),
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
    const url = new URL(req.url ?? "/", "http://localhost");
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

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(configPath) {
  const config = loadConfig(configPath);
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
  const observer = createObserver({
    read: sqliteReader({
      dbPath: config.dbPath,
      authorized: config.authorizedConnections ?? [],
      gateway: config.gateway ?? {},
    }),
    pollMs,
  });
  const server = createUsageServer({ observer, token: readSecretFile(config.tokenFile) });

  let publish = null;
  if (config.happy?.artifactId) {
    const { socketPath, tokenFile, artifactId } = config.happy;
    publish = createPublisher({
      // The daemon token is read for each write, so a rotated token is picked up.
      write: ({ value, writeId }) =>
        putKv({ socketPath, token: readSecretFile(tokenFile), artifactId, value, writeId }),
      heartbeatMs: config.happy.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    });
  }

  let lastPublishError = null;
  const tick = async () => {
    observer.poll();
    if (!publish) return;
    try {
      await publish(observer.payload());
      if (lastPublishError) log("happy publish recovered");
      lastPublishError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastPublishError) log(`happy publish failed: ${message}`);
      lastPublishError = message;
    }
  };
  await tick();
  const timer = setInterval(tick, pollMs);

  // A port in use or a refused bind ends the process, so the supervisor retries it.
  server.on("error", (error) => {
    log(`fatal: ${error.message}`);
    process.exit(1);
  });
  server.on("listening", () => log(`listening on ${JSON.stringify(server.address())}`));
  if (config.listen?.socket) {
    rmSync(config.listen.socket, { force: true });
    server.listen(config.listen.socket);
  } else {
    // Loopback only: the report names accounts and is not meant for the network.
    server.listen(config.listen?.port ?? DEFAULT_PORT, "127.0.0.1");
  }

  const stop = () => {
    clearInterval(timer);
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
