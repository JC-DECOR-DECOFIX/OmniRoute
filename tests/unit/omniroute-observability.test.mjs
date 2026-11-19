import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildUsageReport,
  sanitizeReason,
} from "../../scripts/ops/omniroute-observability/aggregate.mjs";
import {
  createObserver,
  createPublisher,
  createUsageServer,
  loadConfig,
  readPrivateFile,
  reportFingerprint,
  USAGE_PATH,
} from "../../scripts/ops/omniroute-observability/server.mjs";

const SERVICE_DIR = new URL("../../scripts/ops/omniroute-observability/", import.meta.url);

const NOW = Date.parse("2026-11-19T00:30:00.000Z");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const X = "dddddddd-0000-4000-8000-000000000004";
const SECRET = "sk-ant-oat01-SECRETSECRETSECRET";

const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, email TEXT, name TEXT,
      display_name TEXT, priority INTEGER, is_active INTEGER, test_status TEXT,
      rate_limited_until TEXT, last_error_type TEXT, access_token TEXT, refresh_token TEXT,
      id_token TEXT, api_key TEXT, provider_specific_data TEXT);
    CREATE TABLE call_logs (id TEXT PRIMARY KEY, timestamp TEXT, status INTEGER, model TEXT,
      requested_model TEXT, provider TEXT, account TEXT, connection_id TEXT, error_type TEXT,
      error_summary TEXT, correlation_id TEXT);
    CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY (namespace, key));
    CREATE TABLE quota_snapshots (id INTEGER PRIMARY KEY, provider TEXT, connection_id TEXT,
      window_key TEXT, remaining_percentage REAL, is_exhausted INTEGER, next_reset_at TEXT,
      window_duration_ms INTEGER, raw_data TEXT, created_at TEXT);
  `);
  const conn = db.prepare(
    `INSERT INTO provider_connections VALUES (?, 'claude', ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  );
  conn.run(
    A,
    "one@example.com",
    "one",
    1,
    1,
    "active",
    null,
    SECRET,
    SECRET,
    SECRET,
    SECRET,
    SECRET
  );
  conn.run(
    B,
    "two@example.com",
    "two",
    2,
    1,
    "active",
    at(-30),
    SECRET,
    SECRET,
    SECRET,
    SECRET,
    SECRET
  );
  conn.run(
    C,
    "three@example.com",
    "three",
    4,
    1,
    "active",
    null,
    SECRET,
    SECRET,
    SECRET,
    SECRET,
    SECRET
  );
  conn.run(
    X,
    "old@example.com",
    "old",
    3,
    0,
    "expired",
    null,
    SECRET,
    SECRET,
    SECRET,
    SECRET,
    SECRET
  );

  let n = 0;
  const log = db.prepare(`INSERT INTO call_logs VALUES (?, ?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?)`);
  const add = (minutesAgo, status, connection, email, model, corr, type = null, summary = null) =>
    log.run(
      `r${++n}`,
      at(minutesAgo),
      status,
      model,
      `claude/${model}`,
      email,
      connection,
      type,
      summary,
      corr
    );
  // A request that failed on A with a 429 and was served by C with the same model.
  add(
    60,
    429,
    A,
    "one@example.com",
    "claude-fable-5-2",
    "corr-1",
    "rate_limited",
    `[429]: This request would exceed your account's rate limit. Bearer ${SECRET}`
  );
  add(59, 200, C, "three@example.com", "claude-fable-5-2", "corr-1");
  // A request that failed on A and then on B: the second hop failed too.
  add(30, 502, A, "one@example.com", "claude-opus-5-5", "corr-2", "server_error", "Stream ended");
  add(29, 502, B, "two@example.com", "claude-opus-5-5", "corr-2", "server_error", "Stream ended");
  // Same account retried: not a switch.
  add(20, 504, A, "one@example.com", "claude-opus-5-5", "corr-3", "server_error", "timeout");
  add(19, 200, A, "one@example.com", "claude-opus-5-5", "corr-3");
  // Recent traffic; the newest served request is on B.
  add(2, 200, A, "one@example.com", "claude-opus-5-5", null);
  add(1, 200, B, "two@example.com", "claude-sonnet-5", null);
  add(0.5, 499, C, "three@example.com", "claude-opus-5-5", null, null, "Request aborted");

  const kv = db.prepare(`INSERT INTO key_value VALUES ('providerLimitsCache', ?, ?)`);
  kv.run(
    A,
    JSON.stringify({
      fetchedAt: at(20),
      plan: "max",
      source: "auto",
      quotas: { "weekly (7d)": { used: 50, resetAt: at(-3000) } },
    })
  );
  kv.run(
    B,
    JSON.stringify({
      fetchedAt: at(30),
      plan: "team",
      source: "auto",
      quotas: {
        "session (5h)": { used: 40, resetAt: at(-90) },
        "weekly (7d)": { used: 30, resetAt: at(-4000) },
      },
    })
  );
  kv.run(
    C,
    JSON.stringify({
      fetchedAt: at(15),
      plan: "max",
      source: "auto",
      quotas: {
        "session (5h)": { used: 70, resetAt: at(5) },
        "weekly (7d)": { used: 96, resetAt: at(-5000) },
      },
    })
  );

  const snap = db.prepare(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, remaining_percentage, next_reset_at, created_at)
     VALUES ('claude', ?, ?, ?, ?, ?)`
  );
  // Older five-hour snapshot for A: the newer complete cached reading omitted the window.
  snap.run(A, "session (5h)", 10, at(-60), at(300));
  // Newer than B's cache: the background refresh saw the five-hour window move.
  snap.run(B, "session (5h)", 35, at(-90), at(1));
  return db;
}

const report = () =>
  buildUsageReport(fixture(), { now: NOW, authorized: [A, B, C], gateway: { build: "test" } });
const account = (r, id) => r.accounts.find((a) => a.connectionId === id);

test("never reads or returns credentials", () => {
  const json = JSON.stringify(report());
  assert.equal(json.includes("SECRETSECRET"), false);
  for (const file of ["aggregate.mjs", "server.mjs"]) {
    const source = readFileSync(new URL(file, SERVICE_DIR), "utf8");
    for (const column of [
      "access_token",
      "refresh_token",
      "id_token",
      "api_key",
      "provider_specific_data",
    ]) {
      assert.equal(source.includes(column), false, `${file} mentions ${column}`);
    }
  }
});

test("the current account is the newest served request, not the configured priority", () => {
  const r = report();
  assert.equal(r.current.connectionId, B);
  assert.equal(r.current.email, "two@example.com");
  assert.equal(r.current.emailConfirmed, true);
  assert.equal(r.current.requestedModel, "claude-sonnet-5");
  assert.equal(r.current.effectiveModel, "claude-sonnet-5");
  assert.equal(account(r, B).servedLatest, true);
  assert.equal(account(r, A).servedLatest, false);
});

test("in-use accounts count only served requests in the window", () => {
  const ids = report().inUse.map((entry) => entry.connectionId);
  assert.deepEqual(ids.sort(), [A, B].sort());
});

test("switches come from attempts of one request on different accounts", () => {
  const r = report();
  assert.equal(r.switches.length, 2);
  const [newest, older] = r.switches;
  assert.equal(newest.from.connectionId, A);
  assert.equal(newest.to.connectionId, B);
  assert.equal(newest.outcome, "failed");
  assert.equal(older.from.connectionId, A);
  assert.equal(older.to.connectionId, C);
  assert.equal(older.reason.status, 429);
  assert.equal(older.requestedModel, "claude-fable-5-2");
  assert.equal(older.effectiveModel, "claude-fable-5-2");
  assert.equal(older.outcome, "served");
  assert.equal(older.reason.summary.includes("SECRET"), false);
  assert.deepEqual(r.lastSwitch, newest);
});

test("quota takes the newest confirmed reading per window", () => {
  const r = report();
  const b = account(r, B).quota;
  assert.equal(b.windows.fiveHour.usedPercent, 65);
  assert.equal(b.windows.fiveHour.source.endsWith("quota_snapshots"), true);
  assert.equal(b.windows.weekly.usedPercent, 30);
  assert.equal(b.fetchedAt, at(1));
  assert.equal(b.status, "fresh");
});

test("a window omitted by a newer complete reading is not reported", () => {
  const a = account(report(), A).quota;
  assert.equal(a.windows.fiveHour, null);
  assert.equal(a.windows.weekly.usedPercent, 50);
  assert.equal(a.status, "stale");
});

test("a window that reset after it was read shows no number", () => {
  const c = account(report(), C).quota;
  assert.equal(c.windows.fiveHour.usedPercent, null);
  assert.equal(c.windows.fiveHour.state, "reset_pending_reading");
  assert.equal(c.windows.weekly.usedPercent, 96);
});

test("an account without any reading is unavailable", () => {
  const x = account(report(), X);
  assert.equal(x.quota.status, "unavailable");
  assert.equal(x.authorized, false);
  assert.equal(x.state, "inactive");
});

test("cooldown is reported with its end", () => {
  const b = account(report(), B);
  assert.equal(b.state, "cooldown");
  assert.equal(b.stateUntil, at(-30));
});

test("sanitizeReason redacts tokens and bounds length", () => {
  assert.equal(sanitizeReason(`x ${SECRET} y`), "x [redacted] y");
  assert.equal(sanitizeReason("Bearer abc.def"), "[redacted]");
  assert.equal(sanitizeReason("a".repeat(400)).length, 158);
  assert.equal(sanitizeReason(""), null);
});

test("observer keeps the last report and turns stale when reads fail", () => {
  let clock = NOW;
  let fail = false;
  const observer = createObserver({
    read: () => {
      if (fail) throw new Error("database is locked");
      return {
        schema: "omni-route-usage/v1",
        generatedAt: new Date(clock).toISOString(),
        value: 1,
      };
    },
    pollMs: 1_000,
    now: () => clock,
  });
  assert.equal(observer.payload().observer.status, "unavailable");
  observer.poll();
  assert.equal(observer.payload().observer.status, "fresh");
  fail = true;
  clock += 5_000;
  observer.poll();
  const payload = observer.payload();
  assert.equal(payload.observer.status, "stale");
  assert.equal(payload.observer.lastError, "database is locked");
  assert.equal(payload.value, 1);
});

test("publisher writes on change and on heartbeat only", async () => {
  let clock = NOW;
  const writes = [];
  const publish = createPublisher({
    write: async (w) => writes.push(w),
    heartbeatMs: 60_000,
    now: () => clock,
  });
  const payload = (value) => ({
    generatedAt: new Date(clock).toISOString(),
    value,
    observer: { status: "fresh", lastError: null },
  });
  assert.equal(await publish(payload(1)), "written");
  clock += 15_000;
  assert.equal(await publish(payload(1)), "unchanged");
  assert.equal(await publish(payload(2)), "written");
  clock += 61_000;
  assert.equal(await publish(payload(2)), "written");
  assert.equal(writes.length, 3);
  assert.equal(new Set(writes.map((w) => w.writeId)).size, 3);
});

test("fingerprint ignores poll timestamps", () => {
  const base = {
    schema: "s",
    value: 1,
    observer: { status: "fresh", lastError: null, servedAt: "a" },
  };
  assert.equal(
    reportFingerprint({ ...base, generatedAt: "1" }),
    reportFingerprint({ ...base, generatedAt: "2", observer: { ...base.observer, servedAt: "b" } })
  );
});

test("usage endpoint requires the bearer token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "obs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "s.sock");
  const observer = createObserver({
    read: () => ({ schema: "omni-route-usage/v1", generatedAt: "x" }),
    now: () => NOW,
  });
  const server = createUsageServer({ observer, token: "local-token" });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  const get = (path, token) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path, headers: token ? { authorization: `Bearer ${token}` } : {} },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.on("error", reject);
      req.end();
    });

  assert.equal((await get(USAGE_PATH)).status, 401);
  assert.equal((await get(USAGE_PATH, "wrong")).status, 401);
  assert.equal((await get(USAGE_PATH, "local-token")).status, 503);
  observer.poll();
  const ok = await get(USAGE_PATH, "local-token");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.observer.status, "fresh");
  assert.equal((await get("/other", "local-token")).status, 404);
  assert.equal((await get("/healthz")).status, 200);
});

function privateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "obs-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, content, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  };
  return { dir, write };
}

test("private files must be owner-only", (t) => {
  const { write } = privateDir(t);
  assert.equal(readPrivateFile(write("ok", "value")), "value");
  assert.throws(() => readPrivateFile(write("shared", "value", 0o644)), /mode 0600/);
  assert.throws(() => readPrivateFile(write("group", "value", 0o640)), /mode 0600/);
});

test("configuration is validated before the service starts", (t) => {
  const { dir, write } = privateDir(t);
  const base = { dbPath: join(dir, "db.sqlite"), tokenFile: join(dir, "token") };
  const config = (value, mode) => loadConfig(write("config.json", JSON.stringify(value), mode));
  assert.deepEqual(config(base), base);
  assert.throws(() => config(base, 0o644), /mode 0600/);
  assert.throws(() => config({ ...base, dbPath: "storage.sqlite" }), /dbPath/);
  assert.throws(() => config({ ...base, tokenFile: undefined }), /tokenFile/);
  assert.throws(() => config({ ...base, authorizedConnections: "a,b" }), /authorizedConnections/);
  assert.throws(() => config({ ...base, listen: { port: 70000 } }), /port/);
  assert.throws(() => config({ ...base, pollIntervalMs: 10 }), /pollIntervalMs/);
});

test("the service starts when run through a symlinked install directory", (t) => {
  const { dir, write } = privateDir(t);
  const link = join(dir, "current");
  symlinkSync(fileURLToPath(SERVICE_DIR), link);
  // The token file is missing, so a service that started stops with a fatal log line.
  const configPath = write(
    "config.json",
    JSON.stringify({ dbPath: join(dir, "db.sqlite"), tokenFile: join(dir, "missing-token") })
  );
  const run = spawnSync(process.execPath, [join(link, "server.mjs"), configPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /fatal: .*missing-token/);
});
