import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
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
  coalesce,
  createObserver,
  createPublisher,
  createPublishQueue,
  createRefresher,
  createUsageServer,
  debugLogsRequests,
  exchange,
  gatewaySyncCall,
  loadConfig,
  readFailure,
  readPrivateFile,
  refreshSettings,
  reportFingerprint,
  REFRESH_REQUEST_KEY,
  REFRESH_REQUEST_SCHEMA,
  sqliteReader,
  syncErrorKind,
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
  assert.equal(older.reason.summary.includes("Bearer"), false);
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
  assert.equal(sanitizeReason("a b ".repeat(200)).length, 158);
  assert.equal(sanitizeReason(""), null);
});

test("observer keeps the last report and turns stale when reads fail", () => {
  let clock = NOW;
  let fail = false;
  const observer = createObserver({
    read: () => {
      if (fail) {
        throw Object.assign(new Error("database is locked at /private/path"), {
          code: "ERR_SQLITE_ERROR",
          errstr: "database is locked",
        });
      }
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
  assert.equal(payload.observer.lastError, "ERR_SQLITE_ERROR: database is locked");
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

// Regressions from the independent review of PR #9.

test("a failed read is reported by code, never by its message", () => {
  assert.equal(readFailure(new Error("token=sk-ant-abc leaked at /Users/x")), "read_failed");
  assert.equal(readFailure(Object.assign(new Error("x"), { code: "ENOENT" })), "ENOENT");
  assert.equal(
    readFailure(
      Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errstr: "disk I/O error" })
    ),
    "ERR_SQLITE_ERROR: disk I/O error"
  );
  assert.equal(
    readFailure(
      Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errstr: "no such table x" })
    ),
    "ERR_SQLITE_ERROR"
  );
  assert.equal(readFailure(Object.assign(new Error("x"), { code: "bad code; rm" })), "read_failed");
  assert.equal(readFailure("plain string"), "read_failed");
});

test("free text from the database is redacted beyond known key formats", () => {
  assert.equal(sanitizeReason("upstream said token=abc123def"), "upstream said [redacted]");
  assert.equal(sanitizeReason('{"api_key": "xyz789"} rejected'), '{"[redacted]"} rejected');
  assert.equal(
    sanitizeReason("x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij y"),
    "x [redacted] y"
  );
  assert.equal(sanitizeReason("key AbCdEf0123456789AbCdEf0123456789xyz end"), "key [redacted] end");
  assert.equal(sanitizeReason(`Bearer\n${SECRET}`), "[redacted]");
  const plain = "[429]: This request would exceed your account's rate limit";
  assert.equal(sanitizeReason(plain), plain);
});

test("text fields that do not have their expected shape are dropped", () => {
  const db = fixture();
  db.prepare(
    `INSERT INTO call_logs VALUES ('bad', ?, 200, ?, ?, 'claude', 'one@example.com', ?, NULL, NULL, NULL)`
  ).run(at(0.1), "claude-opus-5-5\nInjected: header", "claude/<script>", A);
  db.prepare("UPDATE key_value SET value = ? WHERE key = ?").run(
    JSON.stringify({
      fetchedAt: at(20),
      plan: "max\u0000<b>",
      quotas: { "weekly (7d)": { used: 50, resetAt: at(-3000) } },
    }),
    A
  );
  const r = buildUsageReport(db, { now: NOW, authorized: [A] });
  assert.equal(r.current.connectionId, A);
  assert.equal(r.current.effectiveModel, null);
  assert.equal(r.current.requestedModel, null);
  assert.equal(account(r, A).quota.plan, null);
  assert.equal(account(r, B).quota.plan, "team");
});

test("a cache entry without quotas does not hide a valid snapshot", () => {
  const db = fixture();
  db.prepare("UPDATE key_value SET value = ? WHERE key = ?").run(
    JSON.stringify({ fetchedAt: at(0), quotas: null }),
    A
  );
  const a = account(buildUsageReport(db, { now: NOW }), A).quota;
  assert.equal(a.windows.fiveHour.usedPercent, 90);
  assert.equal(a.windows.fiveHour.source.endsWith("quota_snapshots"), true);
  assert.equal(a.windows.weekly, null);
  assert.equal(a.fetchedAt, at(300));
  assert.equal(a.status, "stale");
});

test("a missing percentage is not read as 0 % remaining", () => {
  const db = fixture();
  db.prepare(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, remaining_percentage, next_reset_at, created_at)
     VALUES ('claude', ?, 'weekly (7d)', NULL, ?, ?)`
  ).run(C, at(-5000), at(0));
  db.prepare("UPDATE key_value SET value = ? WHERE key = ?").run(
    JSON.stringify({
      fetchedAt: at(15),
      quotas: { "session (5h)": { used: null, resetAt: at(-60) }, "weekly (7d)": { used: 96 } },
    }),
    C
  );
  const c = account(buildUsageReport(db, { now: NOW }), C).quota;
  assert.equal(c.windows.weekly.usedPercent, 96);
  assert.equal(c.windows.weekly.source.endsWith("providerLimitsCache"), true);
  assert.equal(c.windows.fiveHour, null);
});

test("switches skip attempts without an account and attempts outside the look-back", () => {
  const db = fixture();
  const row = db.prepare(
    `INSERT INTO call_logs VALUES (?, ?, ?, 'claude-opus-5-5', 'claude/claude-opus-5-5', 'claude', NULL, ?, NULL, NULL, ?)`
  );
  // A fails, a rejection with no account, then B serves the same request.
  row.run("n1", at(45), 503, A, "corr-4");
  row.run("n2", at(44.9), 400, null, "corr-4");
  row.run("n3", at(44.8), 200, B, "corr-4");
  // An attempt eight days old does not take part in a switch inside the window.
  row.run("o1", at(8 * 24 * 60), 500, A, "corr-5");
  row.run("o2", at(50), 500, B, "corr-5");
  row.run("o3", at(49.9), 200, C, "corr-5");
  // Two attempts with one timestamp keep their insertion order.
  row.run("t1", at(40), 529, C, "corr-6");
  row.run("t2", at(40), 200, A, "corr-6");
  const r = buildUsageReport(db, { now: NOW });
  for (const event of r.switches) {
    assert.notEqual(event.from.connectionId, null);
    assert.notEqual(event.to.connectionId, null);
  }
  const pairs = (corr) =>
    r.switches
      .filter((e) => e.correlationId === corr)
      .map((e) => `${e.from.shortId}>${e.to.shortId}`);
  assert.deepEqual(pairs("corr-4"), ["aaaaaaaa>bbbbbbbb"]);
  assert.deepEqual(pairs("corr-5"), ["bbbbbbbb>cccccccc"]);
  assert.deepEqual(pairs("corr-6"), ["cccccccc>aaaaaaaa"]);
});

test("e-mails come from the connection, not from the call log label", () => {
  const db = fixture();
  db.prepare("UPDATE call_logs SET account = 'Second Account' WHERE id = 'r8'").run();
  const r = buildUsageReport(db, { now: NOW });
  assert.equal(r.current.connectionId, B);
  assert.equal(r.current.email, "two@example.com");
  assert.equal(r.current.emailConfirmed, false);
  assert.equal(JSON.stringify(r).includes("Second Account"), false);
  const [newest] = r.switches;
  assert.equal(newest.to.email, "two@example.com");
});

test("a temporary cooldown marked unavailable still reports its end", () => {
  const db = fixture();
  db.prepare("UPDATE provider_connections SET test_status = 'unavailable' WHERE id = ?").run(B);
  db.prepare(
    "UPDATE provider_connections SET test_status = 'unavailable', rate_limited_until = NULL WHERE id = ?"
  ).run(C);
  const r = buildUsageReport(db, { now: NOW });
  assert.equal(account(r, B).state, "cooldown");
  assert.equal(account(r, B).stateUntil, at(-30));
  assert.equal(account(r, B).testStatus, "unavailable");
  // Without a cooldown end the gateway's selector does not exclude it.
  assert.equal(account(r, C).state, "active");
  assert.equal(account(r, C).stateUntil, null);
  assert.equal(account(r, C).testStatus, "unavailable");
});

test("a poll leaves the database file unchanged", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "obs-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "storage.sqlite");
  const source = fixture();
  source.exec(`VACUUM INTO '${path}'`);
  source.close();
  const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = digest();
  const report = sqliteReader({ dbPath: path, authorized: [A], gateway: {} })(NOW);
  assert.equal(report.current.connectionId, B);
  assert.equal(digest(), before);
});

test("configuration rejects a socket listener and malformed ids", (t) => {
  const { dir, write } = privateDir(t);
  const base = { dbPath: join(dir, "db.sqlite"), tokenFile: join(dir, "token") };
  const config = (value) => loadConfig(write("config.json", JSON.stringify(value)));
  assert.throws(
    () => config({ ...base, listen: { socket: join(dir, "storage.sqlite") } }),
    /socket/
  );
  assert.throws(() => config({ ...base, authorizedConnections: ["ok", "../x"] }), /authorized/);
  assert.throws(() => config({ ...base, gateway: { build: "<b>" } }), /gateway/);
  assert.deepEqual(config({ ...base, gateway: { build: "09966db7" } }).gateway, {
    build: "09966db7",
  });
});

test("a port already in use ends the service with a non-zero exit", async (t) => {
  const { dir, write } = privateDir(t);
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const tokenFile = write("token", "local-token");
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile,
      listen: { port: blocker.address().port },
    })
  );
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("server.mjs", SERVICE_DIR)),
    configPath,
  ]);
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  assert.equal(code, 1);
  assert.match(stdout, /poll failed: (ERR_SQLITE_ERROR|read_failed)/);
  assert.match(stdout, /fatal: .*EADDRINUSE/);
  assert.equal(stdout.includes("local-token"), false);
});

// Regressions from the second independent review of PR #9.

test("connection ids that do not have the id shape never reach the report", () => {
  const db = fixture();
  const odd = "evil id<script>";
  db.prepare(
    `INSERT INTO provider_connections (id, provider, email, priority, is_active, test_status)
     VALUES (?, 'claude', 'odd@example.com', 9, 1, 'active')`
  ).run(odd);
  const row = db.prepare(
    `INSERT INTO call_logs VALUES (?, ?, ?, 'claude-opus-5-5', 'claude/claude-opus-5-5', 'claude', NULL, ?, NULL, NULL, ?)`
  );
  row.run("i1", at(0.2), 200, odd, null);
  row.run("i2", at(10), 500, A, "corr-7");
  row.run("i3", at(9.9), 200, odd, "corr-7");
  row.run("i4", at(0.3), 500, odd, null);
  const r = buildUsageReport(db, { now: NOW });
  assert.equal(JSON.stringify(r).includes("evil"), false);
  assert.equal(r.current.connectionId, B);
  assert.equal(r.accounts.length, 4);
  assert.equal(
    r.switches.some((e) => e.correlationId === "corr-7"),
    false
  );
});

test("a present but invalid window does not hide a valid snapshot", () => {
  const db = fixture();
  db.prepare("UPDATE key_value SET value = ? WHERE key = ?").run(
    JSON.stringify({
      fetchedAt: at(0),
      quotas: {
        "session (5h)": { used: null, resetAt: at(-60) },
        "weekly (7d)": { used: 50, resetAt: at(-3000) },
      },
    }),
    A
  );
  const a = account(buildUsageReport(db, { now: NOW }), A).quota;
  assert.equal(a.windows.fiveHour.usedPercent, 90);
  assert.equal(a.windows.fiveHour.source.endsWith("quota_snapshots"), true);
  assert.equal(a.windows.weekly.usedPercent, 50);
});

test("a newer invalid snapshot does not hide the previous valid one", () => {
  const db = fixture();
  const snap = db.prepare(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, remaining_percentage, next_reset_at, created_at)
     VALUES ('claude', ?, 'session (5h)', ?, ?, ?)`
  );
  snap.run(B, null, at(-90), at(0.5));
  snap.run(B, "n/a", at(-90), at(0.4));
  snap.run(B, 20, at(-90), "not a time");
  const b = account(buildUsageReport(db, { now: NOW }), B).quota;
  assert.equal(b.windows.fiveHour.usedPercent, 65);
  assert.equal(b.windows.fiveHour.capturedAt, at(1));
});

test("the last error ignores successes that share its timestamp", () => {
  const db = fixture();
  const row = db.prepare(
    `INSERT INTO call_logs VALUES (?, ?, ?, 'claude-opus-5-5', 'claude/claude-opus-5-5', 'claude', NULL, ?, ?, ?, NULL)`
  );
  row.run("e1", at(3), 429, C, "rate_limited", "limit");
  row.run("e2", at(3), 200, C, null, null);
  const c = account(buildUsageReport(db, { now: NOW }), C);
  assert.equal(c.lastError.status, 429);
  assert.equal(c.lastError.type, "rate_limited");
});

test("the observer turns stale on the first failed poll", () => {
  let clock = NOW;
  let fail = false;
  const observer = createObserver({
    read: () => {
      if (fail) throw new Error("boom");
      return { schema: "omni-route-usage/v1", generatedAt: "x" };
    },
    pollMs: 15_000,
    now: () => clock,
  });
  observer.poll();
  assert.equal(observer.payload().observer.status, "fresh");
  fail = true;
  clock += 1_000;
  observer.poll();
  assert.equal(observer.payload().observer.status, "stale");
  assert.equal(observer.payload().observer.lastError, "read_failed");
  fail = false;
  observer.poll();
  assert.equal(observer.payload().observer.status, "fresh");
});

// Regressions from the third independent review of PR #9.

test("ids with a NUL byte or stored as a blob never reach the report", () => {
  const db = fixture();
  const row = db.prepare(
    `INSERT INTO call_logs VALUES (?, ?, ?, 'claude-opus-5-5', 'claude/claude-opus-5-5', 'claude', NULL, ?, NULL, NULL, ?)`
  );
  row.run("z1", at(0.2), 200, `${B}\u0000<script>`, null);
  row.run("z2", at(0.15), 200, new Uint8Array([97, 98, 99]), null);
  row.run("z3", at(10), 500, A, "corr-8");
  row.run("z4", at(9.9), 200, `${C}\u0000x`, "corr-8");
  const r = buildUsageReport(db, { now: NOW });
  const json = JSON.stringify(r);
  assert.equal(json.includes("<script>"), false);
  assert.equal(json.includes("\\u0000"), false);
  assert.equal(r.current.at, at(1));
  for (const entry of r.inUse) assert.equal(typeof entry.connectionId, "string");
  assert.deepEqual(r.inUse.map((entry) => entry.connectionId).sort(), [A, B].sort());
  assert.equal(
    r.switches.some((e) => e.correlationId === "corr-8"),
    false
  );
});

test("account state follows the gateway's selector", () => {
  const db = fixture();
  const set = db.prepare(
    "UPDATE provider_connections SET test_status = ?, rate_limited_until = ? WHERE id = ?"
  );
  set.run("banned", null, A);
  set.run(" Credits_Exhausted ", at(-30), B);
  set.run("unavailable", at(5), C);
  const r = buildUsageReport(db, { now: NOW });
  assert.equal(account(r, A).state, "banned");
  assert.equal(account(r, B).state, "credits_exhausted");
  assert.equal(account(r, B).stateUntil, null);
  // A cooldown that has ended no longer excludes the account.
  assert.equal(account(r, C).state, "active");
  assert.equal(account(r, C).testStatus, "unavailable");
  assert.equal(account(r, X).state, "inactive");
});

test("many snapshots with unreadable times do not hide the last valid one", () => {
  const db = fixture();
  const snap = db.prepare(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, remaining_percentage, next_reset_at, created_at)
     VALUES ('claude', ?, 'session (5h)', 10, NULL, ?)`
  );
  // V8's Date.parse reads strings like these as dates in 2000 and 2001.
  for (let i = 0; i < 60; i++) snap.run(B, `zz-not-a-time-${i}`);
  snap.run(B, "x 5");
  const b = account(buildUsageReport(db, { now: NOW }), B).quota;
  assert.equal(b.windows.fiveHour.usedPercent, 65);
});

// Regression from the fourth independent review of PR #9.

test("a malformed request target is answered with 400 and the server keeps serving", async (t) => {
  const observer = createObserver({
    read: () => ({ schema: "omni-route-usage/v1", generatedAt: "x" }),
    now: () => NOW,
  });
  observer.poll();
  const server = createUsageServer({ observer, token: "local-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const raw = (target) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      );
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data.split(" ")[1]));
      socket.on("error", reject);
    });
  for (const target of ["//", "//a:b@", "//[::1"]) assert.equal(await raw(target), "400");
  assert.equal(await raw("/healthz"), "200");
  const ok = await new Promise((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port,
          path: USAGE_PATH,
          headers: { authorization: "Bearer local-token" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      )
      .on("error", reject);
  });
  assert.equal(ok, 200);
});

// Manual refresh requested from the panel.

const GATEWAY_TOKEN = "oma_FAKEGATEWAYTOKEN0123456789abcdef";
const version = (n) => `019a${String(n).padStart(4, "0")}-0000-7000-8000-000000000000`;

/**
 * A refresher over a fake gateway sync and a report whose quota times move when the sync reads
 * an account. `result` is what the sync call returns (default: it ran without errors);
 * `updated` lists the accounts it reads again (default: all, when it ran); `states` sets an
 * account's state in the report.
 */
function refreshHarness({
  result = { kind: "ok", errors: {} },
  updated = null,
  states = {},
  token = GATEWAY_TOKEN,
  connections = [A, B, C],
  failPublish = () => false,
} = {}) {
  let clock = NOW;
  const fetchedAt = new Map(connections.map((id) => [id, NOW - 3_600_000]));
  const calls = [];
  const published = [];
  const logs = [];
  let reads = 0;
  let gate = null;
  let refresher = null;
  const observer = createObserver({
    read: (now) => {
      reads += 1;
      return {
        schema: "omni-route-usage/v1",
        generatedAt: new Date(now).toISOString(),
        accounts: connections.map((id) => ({
          connectionId: id,
          state: states[id] ?? "active",
          quota: { fetchedAt: new Date(fetchedAt.get(id)).toISOString() },
        })),
      };
    },
    now: () => clock,
    refreshState: () => refresher.state(),
  });
  observer.poll();
  refresher = createRefresher({
    observer,
    connections,
    readToken: () => {
      if (token === null) throw new Error("ENOENT: /private/omniroute-access-token");
      return token;
    },
    callGateway: async ({ token: sent, connections: asked, timeoutMs }) => {
      calls.push({ token: sent, connections: asked, timeoutMs, at: clock });
      if (gate) await gate.promise;
      // The sync stamps each reading as it takes it, before the call returns.
      clock += result.delayMs ?? 500;
      for (const id of updated ?? (result.kind === "ok" ? connections : [])) {
        fetchedAt.set(id, clock - 100);
      }
      return result;
    },
    minIntervalMs: 120_000,
    timeoutMs: 60_000,
    onChange: async () => {
      const payload = structuredClone(observer.payload());
      if (failPublish(payload)) throw new Error("happy kv write returned HTTP 503");
      published.push(payload);
    },
    log: (message) => logs.push(message),
    now: () => clock,
  });
  const entry = (n, ageMs = 0, value = { schema: REFRESH_REQUEST_SCHEMA }) => ({
    key: REFRESH_REQUEST_KEY,
    value,
    deleted: false,
    version: version(n),
    updatedAt: clock - ageMs,
    updatedBy: "u1",
    writeId: null,
  });
  const hold = () => {
    let release;
    gate = { promise: new Promise((resolve) => (release = resolve)) };
    return () => {
      gate = null;
      release();
    };
  };
  return {
    refresher,
    observer,
    calls,
    published,
    logs,
    entry,
    hold,
    reads: () => reads,
    advance: (ms) => (clock += ms),
    now: () => clock,
    statuses: () => published.map((p) => p.refresh.last?.status),
  };
}

test("a refresh publishes running, then done, after one sync call", async () => {
  const h = refreshHarness();
  h.refresher.offer(null);
  const start = h.now();
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  assert.deepEqual(h.statuses(), ["running", "done"]);
  const [running, done] = h.published.map((p) => p.refresh);
  assert.equal(running.last.startedAt, new Date(start).toISOString());
  assert.equal(running.last.finishedAt, null);
  assert.equal(running.nextAllowedAt, new Date(start + 120_000).toISOString());
  assert.equal(done.minIntervalMs, 120_000);
  assert.equal(done.nextAllowedAt, running.nextAllowedAt);
  assert.equal(done.last.requestVersion, version(1));
  assert.equal(done.last.requestedAt, new Date(start).toISOString());
  assert.equal(done.last.error, null);
  assert.deepEqual(done.last.accounts, [
    { shortId: "aaaaaaaa", updated: true, reason: null },
    { shortId: "bbbbbbbb", updated: true, reason: null },
    { shortId: "cccccccc", updated: true, reason: null },
  ]);
  // One sync for all accounts, with the token from the file and the configured timeout.
  assert.deepEqual(h.calls, [
    { token: GATEWAY_TOKEN, connections: [A, B, C], timeoutMs: 60_000, at: start },
  ]);
  assert.deepEqual(h.logs, ["refresh requested", "refresh done 3/3"]);
});

test("a request inside the minimum interval is throttled without calling the gateway", async () => {
  const h = refreshHarness();
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  const nextAllowedAt = h.refresher.state().nextAllowedAt;
  const readsBefore = h.reads();
  h.advance(30_000);
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.reads(), readsBefore + 1, "the database is read again");
  const last = h.published.at(-1).refresh;
  assert.equal(last.nextAllowedAt, nextAllowedAt);
  assert.deepEqual(last.last, {
    requestVersion: version(2),
    requestedAt: new Date(h.now()).toISOString(),
    status: "throttled",
    startedAt: null,
    finishedAt: new Date(h.now()).toISOString(),
    accounts: [],
    error: null,
  });
  assert.equal(h.logs.at(-1), "refresh throttled");
  // Once the interval has passed, a new request reads the vendor again.
  h.advance(120_000);
  h.refresher.offer(h.entry(3));
  await h.refresher.idle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.published.at(-1).refresh.last.status, "done");
});

test("a sync that updates some accounts is partial and says why for the others", async () => {
  const D = "eeeeeeee-0000-4000-8000-000000000005";
  const E = "ffffffff-0000-4000-8000-000000000006";
  const G = "99999999-0000-4000-8000-000000000007";
  const H = "88888888-0000-4000-8000-000000000008";
  const h = refreshHarness({
    connections: [A, B, C, D, E, G, H],
    result: {
      kind: "ok",
      errors: { [A]: "lease", [B]: "auth", [D]: "network", [E]: "other" },
    },
    updated: [C],
    states: { [G]: "inactive" },
  });
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  const { last } = h.published.at(-1).refresh;
  assert.equal(last.status, "partial");
  assert.equal(last.error, null);
  const probable = "a Anthropic não devolveu a cota (provável limite de consultas)";
  assert.deepEqual(
    last.accounts.map((a) => [a.shortId, a.updated, a.reason]),
    [
      ["aaaaaaaa", false, "em uso exclusivo"],
      ["bbbbbbbb", false, "credencial da conta recusada"],
      ["cccccccc", true, null],
      ["eeeeeeee", false, "Anthropic inacessível"],
      ["ffffffff", false, probable],
      ["99999999", false, "não incluída no sync do Omni Route"],
      // Read without an error but with no new reading: Anthropic answered without quotas.
      ["88888888", false, probable],
    ]
  );
  assert.equal(h.logs.at(-1), "refresh partial 1/7");
});

test("an account missing from the report was not in the sync", async () => {
  const h = refreshHarness({ updated: [A, B] });
  // The report lists only A and B; C has no connection row any more.
  const read = h.observer.payload;
  h.observer.payload = () => {
    const p = read();
    return { ...p, accounts: p.accounts.filter((a) => a.connectionId !== C) };
  };
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  assert.deepEqual(h.refresher.state().last.accounts[2], {
    shortId: "cccccccc",
    updated: false,
    reason: "não incluída no sync do Omni Route",
  });
});

test("a sync rejected by the gateway fails with its cause", async () => {
  const h = refreshHarness({ result: { kind: "http", status: 401 } });
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  const refresh = h.published.at(-1).refresh;
  assert.equal(refresh.last.status, "failed");
  assert.equal(refresh.last.error, "gateway_auth_failed");
  assert.ok(refresh.last.accounts.every((a) => a.reason === "credencial do painel recusada"));
  assert.notEqual(refresh.nextAllowedAt, null, "a failed call still counts against the interval");
  assert.equal(h.logs.at(-1), "refresh failed: gateway_auth_failed");
});

test("other failures of the sync call are reported by kind", async () => {
  const cases = [
    [{ kind: "network" }, "gateway_unreachable", "Omni Route inacessível"],
    [{ kind: "timeout" }, "gateway_timeout", "tempo esgotado"],
    [{ kind: "http", status: 403 }, "gateway_auth_failed", "credencial do painel recusada"],
    [{ kind: "http", status: 502 }, "gateway_http_502", "Omni Route respondeu HTTP 502"],
  ];
  for (const [result, error, reason] of cases) {
    const h = refreshHarness({ result });
    h.refresher.offer(null);
    h.refresher.offer(h.entry(1));
    await h.refresher.idle();
    const { last } = h.published.at(-1).refresh;
    assert.equal(last.status, "failed");
    assert.equal(last.error, error);
    assert.ok(last.accounts.every((a) => a.reason === reason));
    assert.equal(h.logs.at(-1), `refresh failed: ${error}`);
  }
  // A sync that ran but read nothing again has no single cause.
  const none = refreshHarness({ updated: [] });
  none.refresher.offer(null);
  none.refresher.offer(none.entry(1));
  await none.refresher.idle();
  const { last } = none.published.at(-1).refresh;
  assert.equal(last.status, "failed");
  assert.equal(last.error, null);
  assert.equal(none.logs.at(-1), "refresh failed: no account updated");
});

test("without the gateway token file a request fails as not configured and calls nothing", async () => {
  const h = refreshHarness({ token: null });
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  const refresh = h.published.at(-1).refresh;
  assert.equal(refresh.nextAllowedAt, null);
  assert.equal(refresh.last.status, "failed");
  assert.equal(refresh.last.error, "not_configured");
  assert.equal(refresh.last.startedAt, null);
  assert.equal(h.logs.at(-1), "refresh failed: not_configured");
  assert.equal(JSON.stringify([h.published, h.logs]).includes("/private"), false);
});

test("at start an old request is marked seen without being served", async () => {
  const h = refreshHarness();
  h.refresher.offer(h.entry(1, 91_000));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.published.length, 0);
  assert.equal(h.refresher.state().last, null);
  // The same entry read again stays seen; a newer one is served.
  h.refresher.offer(h.entry(1, 91_000));
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.refresher.state().last.requestVersion, version(2));
});

test("at start a recent request is served once", async () => {
  const h = refreshHarness();
  h.refresher.offer(h.entry(1, 10_000));
  await h.refresher.idle();
  h.refresher.offer(h.entry(1, 10_000));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.statuses(), ["running", "done"]);
});

test("a request that arrives during a refresh is answered when it ends", async () => {
  const h = refreshHarness();
  h.refresher.offer(null);
  const release = h.hold();
  h.refresher.offer(h.entry(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.statuses(), ["running"]);
  h.refresher.offer(h.entry(2));
  h.refresher.offer(h.entry(3));
  release();
  await h.refresher.idle();
  assert.equal(h.calls.length, 1, "one refresh at a time");
  assert.deepEqual(h.statuses(), ["running", "done", "throttled"]);
  assert.equal(h.refresher.state().last.requestVersion, version(3));
});

test("entries that are not refresh requests are ignored", async () => {
  const h = refreshHarness();
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1, 0, { schema: "something-else" }));
  h.refresher.offer({ ...h.entry(2), deleted: true, value: null });
  h.refresher.offer({ ...h.entry(3), version: "not-a-version" });
  h.refresher.offer({ ...h.entry(4), version: version(4).toUpperCase() });
  h.refresher.offer({ ...h.entry(5), updatedAt: "yesterday" });
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.published.length, 0);
  // An older version than one already seen is not a new request.
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
});

test("the refresh state changes the published fingerprint", () => {
  const base = { schema: "s", generatedAt: "1", observer: { status: "fresh", lastError: null } };
  const running = { ...base, refresh: { last: { status: "running" } } };
  const done = { ...base, refresh: { last: { status: "done" } } };
  assert.notEqual(reportFingerprint(running), reportFingerprint(done));
  assert.notEqual(reportFingerprint({ ...base, refresh: null }), reportFingerprint(running));
});

test("published states are written in order even while another write is in flight", async () => {
  let state = "tick";
  const written = [];
  let release;
  const first = new Promise((resolve) => (release = resolve));
  let calls = 0;
  // A plain publisher in the service refuses a write while another one is in flight.
  let inFlight = false;
  const flush = createPublishQueue({
    publish: async (payload) => {
      assert.equal(inFlight, false);
      inFlight = true;
      calls += 1;
      if (calls === 1) await first;
      written.push(payload.state);
      inFlight = false;
    },
    payload: () => ({ state }),
  });
  // A tick's write is in flight when the refresh starts and publishes "running".
  const tick = flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  state = "running";
  const running = flush();
  release();
  await running;
  state = "done";
  await flush();
  await tick;
  assert.deepEqual(written, ["tick", "running", "done"]);
});

test("a publish failure does not stop the queue", async () => {
  const errors = [];
  let n = 0;
  const flush = createPublishQueue({
    publish: async () => {
      n += 1;
      if (n === 1) throw new Error("happy kv write returned HTTP 503");
      return "written";
    },
    payload: () => ({}),
    onResult: (error, result) => errors.push(error?.message ?? result),
  });
  // Each caller learns how its own publish went; the next one still runs.
  const first = flush();
  const second = flush();
  await assert.rejects(first, /HTTP 503/);
  assert.equal(await second, "written");
  assert.deepEqual(errors, ["happy kv write returned HTTP 503", "written"]);
});

test("refresh configuration is validated", (t) => {
  const { dir, write } = privateDir(t);
  const base = {
    dbPath: join(dir, "db.sqlite"),
    tokenFile: join(dir, "token"),
    authorizedConnections: [A],
    happy: { socketPath: join(dir, "s.sock"), tokenFile: join(dir, "happy"), artifactId: "art1" },
  };
  const refresh = { tokenFile: join(dir, "omniroute-access-token") };
  const config = (value) => loadConfig(write("config.json", JSON.stringify(value)));
  assert.deepEqual(refreshSettings(config({ ...base, refresh })), {
    baseUrl: "http://127.0.0.1:20128",
    tokenFile: refresh.tokenFile,
    minIntervalMs: 120_000,
    requestPollMs: 2_000,
    timeoutMs: 60_000,
  });
  // The sync spaces its own reads; a spacing left from the per-account version is ignored.
  assert.equal(
    Object.hasOwn(
      refreshSettings(config({ ...base, refresh: { ...refresh, spacingMs: 1 } })),
      "spacingMs"
    ),
    false
  );
  assert.equal(
    refreshSettings(config({ ...base, refresh: { ...refresh, timeoutMs: 120_000 } })).timeoutMs,
    120_000
  );
  for (const baseUrl of ["http://localhost:20128", "https://[::1]:20128/"]) {
    assert.equal(config({ ...base, refresh: { ...refresh, baseUrl } }).refresh.baseUrl, baseUrl);
  }
  for (const baseUrl of [
    "http://192.168.0.15:20128",
    "http://example.com",
    "http://127.0.0.1.example.com",
    "http://user:pass@127.0.0.1:20128",
    "http://127.0.0.1:20128/api",
    "http://127.0.0.1:20128/?x=1",
    "ftp://127.0.0.1",
    "not a url",
  ]) {
    assert.throws(() => config({ ...base, refresh: { ...refresh, baseUrl } }), /baseUrl/, baseUrl);
  }
  const bad = [
    [{ minIntervalMs: 59_999 }, /minIntervalMs/],
    [{ requestPollMs: 499 }, /requestPollMs/],
    [{ requestPollMs: 10_001 }, /requestPollMs/],
    [{ timeoutMs: 4_999 }, /timeoutMs/],
    [{ timeoutMs: 120_001 }, /timeoutMs/],
    [{ tokenFile: "token" }, /tokenFile/],
    // An explicit null is not the default: it would remove the interval or the poll delay.
    [{ minIntervalMs: null }, /minIntervalMs/],
    [{ requestPollMs: null }, /requestPollMs/],
    [{ timeoutMs: null }, /timeoutMs/],
    [{ baseUrl: null }, /baseUrl/],
    [{ baseUrl: 20128 }, /baseUrl/],
    [{ minIntervalMs: 120_000.5 }, /minIntervalMs/],
  ];
  for (const [change, error] of bad) {
    assert.throws(() => config({ ...base, refresh: { ...refresh, ...change } }), error);
  }
  assert.throws(() => config({ ...base, happy: undefined, refresh }), /happy/);
  assert.throws(() => config({ ...base, authorizedConnections: [], refresh }), /authorized/);
  assert.throws(() => config({ ...base, refresh: [] }), /refresh/);
  assert.equal(refreshSettings(config(base)), null);
});

test("without refresh configured the report carries refresh: null", () => {
  const observer = createObserver({
    read: () => ({ schema: "omni-route-usage/v1", generatedAt: "x" }),
    now: () => NOW,
  });
  observer.poll();
  assert.equal(observer.payload().refresh, null);
  assert.equal(Object.hasOwn(observer.payload(), "refresh"), true);
});

/** A fake Omni Route: answers each path with the response the test set for it. */
async function fakeGateway(t, respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });
      respond(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen };
}

test("the sync call keeps only the status and the kind of error of the given accounts", async (t) => {
  const secretBody = `upstream 429 rate limited ${SECRET} Bearer ${GATEWAY_TOKEN}`;
  let mode = "ok";
  const { baseUrl, seen } = await fakeGateway(t, (_req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // What the route answers: the sync's counts and errors, then every provider's cache.
    if (mode === "ok") {
      return json(200, {
        total: 7,
        succeeded: 5,
        failed: 2,
        errors: {
          [A]: "Failed to refresh credentials. Please re-authorize the connection.",
          [X]: `codex ${secretBody}`,
        },
        caches: {
          [B]: { fetchedAt: "2026-11-19T19:00:00.000Z", plan: "max", accessToken: SECRET },
          codex: { message: secretBody },
        },
        intervalMinutes: 70,
        lastAutoSyncAt: "2026-11-19T18:00:00.000Z",
      });
    }
    if (mode === "noerrors") return json(200, { total: 1, caches: {} });
    if (mode === "notjson") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(secretBody);
    }
    if (mode === "denied") return json(401, { error: secretBody });
    if (mode === "scope") return json(403, { error: secretBody });
    if (mode === "broken") return json(500, { error: "Failed to refresh provider limits" });
    if (mode === "huge") {
      return json(200, { errors: { [A]: "fetch failed" }, pad: "x".repeat(1_200_000) });
    }
    if (mode === "cut") {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"errors":');
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    if (mode === "trickle") {
      // Headers and a byte every 50 ms, forever: no inactivity timeout would fire.
      res.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => res.write(" "), 50);
      res.on("close", () => clearInterval(timer));
      return;
    }
    // "slow" never answers.
  });
  const call = (next, timeoutMs = 5_000) => {
    mode = next;
    return gatewaySyncCall({ baseUrl, token: GATEWAY_TOKEN, connections: [A, B, C], timeoutMs });
  };
  // Only the authorized accounts' errors are kept, as a kind; nothing else of the body.
  const ok = await call("ok");
  assert.deepEqual(ok, { kind: "ok", errors: { [A]: "auth" } });
  assert.equal(JSON.stringify(ok).includes("sk-ant"), false);
  assert.deepEqual(await call("noerrors"), { kind: "ok", errors: {} });
  assert.deepEqual(await call("notjson"), { kind: "ok", errors: {} });
  assert.deepEqual(await call("denied"), { kind: "http", status: 401 });
  assert.deepEqual(await call("scope"), { kind: "http", status: 403 });
  assert.deepEqual(await call("broken"), { kind: "http", status: 500 });
  assert.deepEqual(await call("huge"), { kind: "network" });
  assert.deepEqual(await call("cut"), { kind: "network" });
  assert.deepEqual(await call("slow", 200), { kind: "timeout" });
  const started = Date.now();
  assert.deepEqual(await call("trickle", 300), { kind: "timeout" });
  assert.ok(Date.now() - started < 2_000, "the deadline covers the whole exchange");
  // One POST to the sync route, with an empty JSON body and the access token.
  assert.deepEqual(seen[0], {
    method: "POST",
    url: "/api/usage/provider-limits",
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    contentType: "application/json",
    body: "",
  });
  assert.ok(seen.every((r) => r.method === "POST" && r.url === "/api/usage/provider-limits"));
});

test("errors recorded by the sync are classified by their fixed texts", () => {
  const cases = [
    ["Usage refresh deferred while an exclusive lease is active", "lease"],
    ["Failed to refresh credentials. Please re-authorize the connection.", "auth"],
    ["Token expired, please re-authenticate", "auth"],
    ["HTTP 403 Forbidden", "auth"],
    ["fetch failed", "network"],
    ["connect ECONNREFUSED 127.0.0.1:8080", "network"],
    ["Provider-limits proxy request failed", "network"],
    ["Usage not available for this connection", "other"],
    ["Failed to refresh provider limits", "other"],
    [null, "other"],
    [{ message: "fetch failed" }, "other"],
  ];
  for (const [message, kind] of cases) assert.equal(syncErrorKind(message), kind, message);
});

test("an unreachable gateway is a network failure", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = blocker.address();
  await new Promise((resolve) => blocker.close(resolve));
  const result = await gatewaySyncCall({
    baseUrl: `http://127.0.0.1:${port}`,
    token: GATEWAY_TOKEN,
    connections: [A],
    timeoutMs: 5_000,
  });
  assert.deepEqual(result, { kind: "network" });
});

/**
 * A fake Happy daemon on a Unix socket: records requests and answers kv reads of the request
 * key with `requestEntry()`.
 */
async function fakeDaemon(t, dir, requestEntry = () => null) {
  const requests = [];
  const socketPath = join(dir, "d.sock");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") res.end(JSON.stringify({ entry: requestEntry(), cursor: null }));
      else res.end(JSON.stringify({ entry: {}, replayed: false }));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { socketPath, requests };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startService(t, configPath, env = process.env) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("server.mjs", SERVICE_DIR)), configPath],
    { env }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => child.kill("SIGKILL"));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitFor(predicate, ms = 8_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

test("the service without a refresh block publishes refresh: null and never reads requests", async (t) => {
  const { dir, write } = privateDir(t);
  const daemon = await fakeDaemon(t, dir);
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile: write("token", "local-token"),
      listen: { port: await freePort() },
      happy: {
        socketPath: daemon.socketPath,
        tokenFile: write("happy", "daemon-token"),
        artifactId: "art1",
      },
    })
  );
  startService(t, configPath);
  await waitFor(() => daemon.requests.some((r) => r.method === "PUT"));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(
    daemon.requests.some((r) => r.method === "GET"),
    false
  );
  const put = daemon.requests.find((r) => r.method === "PUT");
  assert.equal(put.body.value.refresh, null);
});

test("the service reads refresh requests through the daemon and answers them", async (t) => {
  const { dir, write } = privateDir(t);
  const entry = {
    key: REFRESH_REQUEST_KEY,
    value: { schema: REFRESH_REQUEST_SCHEMA, extra: GATEWAY_TOKEN },
    deleted: false,
    version: version(7),
    updatedAt: Date.now(),
  };
  const daemon = await fakeDaemon(t, dir, () => entry);
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile: write("token", "local-token"),
      authorizedConnections: [A],
      listen: { port: await freePort() },
      happy: {
        socketPath: daemon.socketPath,
        tokenFile: write("happy", "daemon-token"),
        artifactId: "art1",
      },
      refresh: { tokenFile: join(dir, "omniroute-access-token"), requestPollMs: 500 },
    })
  );
  const service = startService(t, configPath);
  const answered = () =>
    daemon.requests.find((r) => r.method === "PUT" && r.body.value.refresh?.last);
  await waitFor(answered);
  const get = daemon.requests.find((r) => r.method === "GET" && r.url.endsWith("refresh-request"));
  assert.equal(get.url, "/v0/artifacts/art1/api/v1/kv/entry?key=omni-route%2Frefresh-request");
  assert.equal(get.authorization, "Bearer daemon-token");
  const { refresh } = answered().body.value;
  assert.equal(refresh.minIntervalMs, 120_000);
  assert.equal(refresh.last.requestVersion, version(7));
  assert.equal(refresh.last.error, "not_configured");
  // The first report already carries the refresh state, before any request is answered.
  const firstPut = daemon.requests.find((r) => r.method === "PUT");
  assert.deepEqual(firstPut.body.value.refresh, {
    minIntervalMs: 120_000,
    nextAllowedAt: null,
    last: null,
  });
  await waitFor(() => service.stdout().includes("refresh failed: not_configured"));
  const everything =
    JSON.stringify(daemon.requests.filter((r) => r.method === "PUT")) + service.stdout();
  assert.equal(everything.includes(GATEWAY_TOKEN), false);
  assert.equal(service.stdout().includes("daemon-token"), false);
});

test("no gateway token appears in a published refresh or its log", async () => {
  for (const result of [
    { kind: "http", status: 401 },
    { kind: "ok", errors: { [A]: "auth", [B]: "other" } },
  ]) {
    const h = refreshHarness({ result, updated: [C] });
    h.refresher.offer(null);
    h.refresher.offer(h.entry(1));
    await h.refresher.idle();
    const everything = JSON.stringify([h.published, h.logs]);
    for (const needle of [GATEWAY_TOKEN, "oma_", "Bearer ", "sk-ant"]) {
      assert.equal(everything.includes(needle), false, needle);
    }
  }
});

test("the service runs one sync per request and publishes nothing of its answer", async (t) => {
  const { dir, write } = privateDir(t);
  // The gateway's database, as the sync leaves it: A and C read again, B kept its old reading.
  const dbPath = join(dir, "storage.sqlite");
  const seed = fixture();
  seed.exec(`VACUUM INTO '${dbPath}'`);
  seed.close();
  const secretBody = `Bearer ${GATEWAY_TOKEN} ${SECRET}`;
  const gateway = await fakeGateway(t, (_req, res) => {
    const db = new DatabaseSync(dbPath);
    const fresh = new Date().toISOString();
    for (const id of [A, C]) {
      db.prepare(
        `UPDATE key_value SET value = json_set(value, '$.fetchedAt', ?)
         WHERE namespace = 'providerLimitsCache' AND key = ?`
      ).run(fresh, id);
    }
    db.close();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        total: 7,
        succeeded: 6,
        failed: 1,
        errors: { [B]: "Failed to refresh credentials. Please re-authorize the connection." },
        caches: { [B]: { message: secretBody }, codex: { note: secretBody } },
      })
    );
  });
  const entry = {
    key: REFRESH_REQUEST_KEY,
    value: { schema: REFRESH_REQUEST_SCHEMA },
    deleted: false,
    version: version(11),
    updatedAt: Date.now(),
  };
  const daemon = await fakeDaemon(t, dir, () => entry);
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath,
      tokenFile: write("token", "local-token"),
      authorizedConnections: [A, B, C],
      listen: { port: await freePort() },
      happy: {
        socketPath: daemon.socketPath,
        tokenFile: write("happy", "daemon-token"),
        artifactId: "art1",
      },
      refresh: {
        baseUrl: gateway.baseUrl,
        tokenFile: write("omniroute-access-token", GATEWAY_TOKEN),
        requestPollMs: 500,
      },
    })
  );
  const service = startService(t, configPath);
  const answered = () =>
    daemon.requests.find(
      (r) =>
        r.method === "PUT" &&
        ["done", "partial", "failed"].includes(r.body.value.refresh?.last?.status)
    );
  await waitFor(answered);
  // The same request read again on later polls is not served again.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(gateway.seen.length, 1);
  assert.equal(gateway.seen[0].method, "POST");
  assert.equal(gateway.seen[0].url, "/api/usage/provider-limits");
  const { last } = answered().body.value.refresh;
  assert.equal(last.status, "partial");
  assert.deepEqual(
    last.accounts.map((a) => [a.shortId, a.updated, a.reason]),
    [
      ["aaaaaaaa", true, null],
      ["bbbbbbbb", false, "credencial da conta recusada"],
      ["cccccccc", true, null],
    ]
  );
  await waitFor(() => service.stdout().includes("refresh partial 2/3"));
  // What was published (the daemon's own credential is in the request headers, not the body).
  const everything =
    JSON.stringify(daemon.requests.filter((r) => r.method === "PUT").map((r) => r.body)) +
    service.stdout() +
    service.stderr();
  for (const needle of [GATEWAY_TOKEN, "oma_", "Bearer ", "sk-ant", "re-authorize", "codex"]) {
    assert.equal(everything.includes(needle), false, needle);
  }
});

// Regressions from the independent review of PR #12.

test("the gateway is not called when the running state cannot be published", async () => {
  let storeDown = true;
  const h = refreshHarness({
    failPublish: (payload) => storeDown && payload.refresh.last?.status === "running",
  });
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  const refresh = h.refresher.state();
  assert.equal(refresh.nextAllowedAt, null, "the request does not use the interval");
  assert.equal(refresh.last.status, "failed");
  assert.equal(refresh.last.error, null);
  assert.equal(refresh.last.startedAt, null);
  assert.deepEqual(h.statuses(), ["failed"]);
  assert.equal(h.logs.at(-1), "refresh failed: publish");
  // Once the store takes writes again, the next request is served.
  storeDown = false;
  h.advance(5_000);
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.deepEqual(h.statuses(), ["failed", "running", "done"]);
  assert.equal(h.calls.length, 1);
});

test("a request seen during a refresh is throttled even when the interval ends meanwhile", async () => {
  const h = refreshHarness();
  h.refresher.offer(null);
  const release = h.hold();
  h.refresher.offer(h.entry(1));
  await new Promise((resolve) => setImmediate(resolve));
  h.refresher.offer(h.entry(2));
  // The first refresh takes longer than the whole interval.
  h.advance(200_000);
  release();
  await h.refresher.idle();
  assert.equal(h.calls.length, 1, "the gateway is read once");
  assert.deepEqual(h.statuses(), ["running", "done", "throttled"]);
  assert.equal(h.refresher.state().last.requestVersion, version(2));
  // A request made after that refresh ended is a new refresh.
  h.advance(1_000);
  h.refresher.offer(h.entry(3));
  await h.refresher.idle();
  assert.equal(h.calls.length, 2);
});

test("an exchange fails on a rejected, interrupted or endless response", async (t) => {
  const { dir } = privateDir(t);
  const socketPath = join(dir, "k.sock");
  const server = http.createServer((req, res) => {
    if (req.url === "/rejected") {
      res.writeHead(503);
      return res.end("draining");
    }
    if (req.url === "/cut") {
      res.writeHead(200, { "content-length": "50" });
      res.write("{");
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (req.url === "/endless") {
      res.writeHead(200);
      const timer = setInterval(() => res.write(" "), 50);
      return res.on("close", () => clearInterval(timer));
    }
    res.writeHead(200);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const call = (path, deadlineMs = 2_000) =>
    exchange({ options: { socketPath, path, method: "PUT" }, deadlineMs, label: "happy kv write" });
  assert.deepEqual(await call("/ok"), { status: 200, text: "{}" });
  assert.deepEqual(await call("/rejected"), { status: 503, text: "draining" });
  await assert.rejects(call("/cut"), (error) => error.kind === "network");
  await assert.rejects(
    call("/endless", 300),
    (error) => error.kind === "timeout" && error.message === "happy kv write timed out"
  );
  await assert.rejects(
    exchange({
      options: { socketPath: join(dir, "missing.sock"), path: "/", method: "GET" },
      deadlineMs: 2_000,
      label: "happy kv read",
    }),
    (error) => error.kind === "network" && !error.message.includes(dir)
  );
});

test("the service keeps publishing after the daemon rejects a write", async (t) => {
  const { dir, write } = privateDir(t);
  const socketPath = join(dir, "d.sock");
  const puts = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "PUT") return res.writeHead(404).end();
      puts.push(Date.now());
      res.writeHead(puts.length === 1 ? 503 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile: write("token", "local-token"),
      listen: { port: await freePort() },
      pollIntervalMs: 1_000,
      happy: { socketPath, tokenFile: write("happy", "daemon-token"), artifactId: "art1" },
    })
  );
  const service = startService(t, configPath);
  await waitFor(() => puts.length >= 2);
  assert.match(service.stdout(), /happy publish failed: happy kv write returned HTTP 503/);
  await waitFor(() => service.stdout().includes("happy publish recovered"));
});

// Regressions from the second independent review of PR #12.

test("a request made during a refresh but first seen after it is throttled", async () => {
  const h = refreshHarness();
  h.refresher.offer(null);
  const release = h.hold();
  h.refresher.offer(h.entry(1));
  await new Promise((resolve) => setImmediate(resolve));
  // The refresh outlasts the interval; the next request is written just before it ends and
  // read only after.
  h.advance(200_000);
  release();
  await h.refresher.idle();
  h.refresher.offer(h.entry(2, 1_000));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.statuses(), ["running", "done", "throttled"]);
  // A request written after the refresh ended, with the interval over, reads the vendor again.
  h.advance(1_000);
  h.refresher.offer(h.entry(3));
  await h.refresher.idle();
  assert.equal(h.calls.length, 2);
});

test("periodic publishes join the one already waiting", async () => {
  let release;
  let calls = 0;
  const run = coalesce(async () => {
    calls += 1;
    await new Promise((resolve) => (release = resolve));
  });
  const waits = Array.from({ length: 10 }, () => run());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all(waits);
  const next = run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  release();
  await next;
});

test("localhost is pinned to the loopback address", (t) => {
  const { dir, write } = privateDir(t);
  const config = loadConfig(
    write(
      "config.json",
      JSON.stringify({
        dbPath: join(dir, "db.sqlite"),
        tokenFile: join(dir, "token"),
        authorizedConnections: [A],
        happy: { socketPath: join(dir, "s"), tokenFile: join(dir, "h"), artifactId: "art1" },
        refresh: { tokenFile: join(dir, "t"), baseUrl: "http://localhost:20128" },
      })
    )
  );
  assert.equal(refreshSettings(config).baseUrl, "http://127.0.0.1:20128");
});

test("a proxy configured for the process never receives a call or its credential", async (t) => {
  const proxied = [];
  const proxy = http.createServer((req, res) => {
    proxied.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(502).end();
  });
  proxy.on("connect", (req, socket) => {
    proxied.push({ url: req.url });
    socket.destroy();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const { baseUrl, seen } = await fakeGateway(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const serverUrl = new URL("server.mjs", SERVICE_DIR).href;
  const script = `
    import http from "node:http";
    const { gatewaySyncCall } = await import(${JSON.stringify(serverUrl)});
    const via = await new Promise((resolve) => {
      http.get(${JSON.stringify(`${baseUrl}/global`)}, (res) => { res.resume(); resolve(res.statusCode); })
        .on("error", () => resolve("error"));
    });
    const direct = await gatewaySyncCall({
      baseUrl: ${JSON.stringify(baseUrl)}, token: ${JSON.stringify(GATEWAY_TOKEN)},
      connections: ["a"], timeoutMs: 5000,
    });
    process.stdout.write(JSON.stringify({ via, direct }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  const { via, direct } = JSON.parse(stdout);
  // The global agent does go through the proxy, so the check below means something.
  assert.equal(via, 502);
  assert.deepEqual(direct, { kind: "ok", errors: {} });
  assert.deepEqual(
    seen.map((r) => r.url),
    ["/api/usage/provider-limits"]
  );
  assert.equal(
    proxied.some((r) => r.authorization?.includes(GATEWAY_TOKEN)),
    false
  );
  assert.deepEqual(
    proxied.map((r) => r.url),
    [`${baseUrl}/global`]
  );
});

// Regressions from the third independent review of PR #12.

test("a timed-out sync reports the accounts it had already read", async () => {
  const h = refreshHarness({ result: { kind: "timeout" } });
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  const { last } = h.refresher.state();
  assert.equal(last.status, "failed");
  assert.equal(last.error, "gateway_timeout");
  assert.ok(last.accounts.every((a) => a.reason === "tempo esgotado"));
  // Readings the sync stored before the deadline count; the error is then not the round's.
  const later = refreshHarness({ result: { kind: "timeout" }, updated: [A] });
  later.refresher.offer(null);
  later.refresher.offer(later.entry(1));
  await later.refresher.idle();
  assert.equal(later.calls.length, 1);
  assert.equal(later.refresher.state().last.status, "partial");
  assert.equal(later.refresher.state().last.error, null);
});

test("after a restart a request already answered is not answered again", async () => {
  const first = refreshHarness();
  first.refresher.offer(null);
  first.refresher.offer(first.entry(1));
  await first.refresher.idle();
  const published = first.published.at(-1).refresh;

  // The new process reads its own last report before publishing anything.
  const h = refreshHarness();
  h.advance(1_000);
  h.refresher.restore(structuredClone(published));
  assert.deepEqual(h.refresher.state(), published);
  h.refresher.offer({ ...h.entry(1), updatedAt: NOW });
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  // A new request inside the restored interval is throttled.
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.refresher.state().last.status, "throttled");
  assert.equal(h.refresher.state().nextAllowedAt, published.nextAllowedAt);
});

test("a refresh cut short by a restart is reported failed and not repeated", async () => {
  const h = refreshHarness();
  h.refresher.restore({
    minIntervalMs: 120_000,
    nextAllowedAt: new Date(NOW + 100_000).toISOString(),
    last: {
      requestVersion: version(1),
      requestedAt: new Date(NOW - 20_000).toISOString(),
      status: "running",
      startedAt: new Date(NOW - 20_000).toISOString(),
      finishedAt: null,
      accounts: [],
      error: null,
    },
  });
  const { last } = h.refresher.state();
  assert.equal(last.status, "failed");
  assert.equal(last.finishedAt, new Date(NOW).toISOString());
  assert.equal(h.logs.at(-1), "refresh interrupted by a restart");
  h.refresher.offer({ ...h.entry(1), updatedAt: NOW - 20_000 });
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
});

test("restored state that is not well formed is not trusted", async () => {
  const restored = (previous) => {
    const h = refreshHarness();
    h.refresher.restore(previous);
    return h;
  };
  const valid = {
    nextAllowedAt: new Date(NOW + 60_000).toISOString(),
    last: { requestVersion: version(1), status: "done", accounts: [] },
  };
  assert.equal(restored(valid).refresher.state().last.requestVersion, version(1));
  // A version from the future would hide every request until then.
  const future = "ffffffff-ffff-7000-8000-000000000000";
  const h = restored({ ...valid, last: { ...valid.last, requestVersion: future } });
  assert.equal(h.refresher.state().last, null);
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
  // An interval pushed far ahead is dropped; foreign fields and text are cleaned.
  const odd = restored({
    nextAllowedAt: "2999-01-01T00:00:00.000Z",
    last: {
      requestVersion: version(1),
      status: "done",
      accounts: [
        { shortId: "<script>", updated: false },
        { shortId: "aaaaaaaa", updated: false, reason: `x ${GATEWAY_TOKEN}`, extra: 1 },
      ],
      error: "pwned",
      injected: true,
    },
  }).refresher.state();
  assert.equal(odd.nextAllowedAt, null);
  assert.deepEqual(odd.last.accounts, [
    { shortId: "aaaaaaaa", updated: false, reason: "x [redacted]" },
  ]);
  assert.equal(odd.last.error, null);
  assert.equal(Object.hasOwn(odd.last, "injected"), false);
  for (const bad of [null, {}, { last: { requestVersion: "x", status: "done" } }]) {
    assert.equal(restored(bad).refresher.state().last, null);
  }
  assert.equal(
    restored({ last: { requestVersion: version(1), status: "weird" } }).refresher.state().last,
    null
  );
});

test("NODE_DEBUG disables the gateway credential", () => {
  assert.equal(debugLogsRequests({}), false);
  assert.equal(debugLogsRequests({ NODE_DEBUG: "" }), false);
  assert.equal(debugLogsRequests({ NODE_DEBUG: "https" }), true);
  assert.equal(debugLogsRequests({ NODE_DEBUG: "net,tls" }), true);
});

test("the service with NODE_DEBUG set never sends the gateway token", async (t) => {
  const { dir, write } = privateDir(t);
  const gateway = await fakeGateway(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const entry = {
    key: REFRESH_REQUEST_KEY,
    value: { schema: REFRESH_REQUEST_SCHEMA },
    deleted: false,
    version: version(9),
    updatedAt: Date.now(),
  };
  const daemon = await fakeDaemon(t, dir, () => entry);
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile: write("token", "local-token"),
      authorizedConnections: [A],
      listen: { port: await freePort() },
      happy: {
        socketPath: daemon.socketPath,
        tokenFile: write("happy", "daemon-token"),
        artifactId: "art1",
      },
      refresh: {
        baseUrl: gateway.baseUrl,
        tokenFile: write("omniroute-access-token", GATEWAY_TOKEN),
        requestPollMs: 500,
      },
    })
  );
  const service = startService(t, configPath, { ...process.env, NODE_DEBUG: "http,https,net" });
  const answered = () =>
    daemon.requests.find((r) => r.method === "PUT" && r.body.value.refresh?.last);
  await waitFor(answered);
  assert.equal(answered().body.value.refresh.last.error, "not_configured");
  assert.equal(gateway.seen.length, 0);
  assert.match(service.stdout(), /refresh disabled while NODE_DEBUG is set/);
  assert.equal(service.stderr().includes(GATEWAY_TOKEN), false);
  assert.equal(service.stdout().includes(GATEWAY_TOKEN), false);
});

test("an exchange whose request cannot be created fails like a network error", async () => {
  const started = Date.now();
  await assert.rejects(
    exchange({
      options: { host: "127.0.0.1", path: "/", method: "GET", headers: { "bad\nname": "x" } },
      deadlineMs: 60_000,
      label: "omni route usage",
    }),
    (error) => error.kind === "network" && error.message.startsWith("omni route usage")
  );
  assert.ok(Date.now() - started < 1_000);
});

// Regressions from the fourth independent review of PR #12.

test("after a restore the first request read still has to be recent", async () => {
  const h = refreshHarness();
  h.refresher.restore({
    nextAllowedAt: null,
    last: {
      requestVersion: version(1),
      status: "done",
      startedAt: new Date(NOW - 600_000).toISOString(),
      finishedAt: new Date(NOW - 595_000).toISOString(),
      accounts: [],
    },
  });
  // Newer than the one answered, but made 100 s ago while the service was down.
  h.refresher.offer(h.entry(2, 100_000));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.refresher.state().last.requestVersion, version(1));
  h.refresher.offer(h.entry(3));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
});

test("a late timeout restarts the interval at the timeout", async () => {
  // The sync read A and B before the 60 s deadline and was still going when it passed.
  const h = refreshHarness({ result: { kind: "timeout", delayMs: 60_000 }, updated: [A, B] });
  h.refresher.offer(null);
  h.refresher.offer(h.entry(1));
  await h.refresher.idle();
  const timedOutAt = h.now();
  assert.equal(h.refresher.state().last.status, "partial");
  assert.equal(h.refresher.state().nextAllowedAt, new Date(timedOutAt + 120_000).toISOString());
  h.advance(100_000);
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.refresher.state().last.status, "throttled");
});

test("the service publishes nothing and answers nothing until its last state is read", async (t) => {
  const { dir, write } = privateDir(t);
  const gateway = await fakeGateway(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const answeredAt = Date.now() - 5_000;
  const previous = {
    schema: "omni-route-usage/v1",
    refresh: {
      minIntervalMs: 120_000,
      nextAllowedAt: new Date(answeredAt + 120_000).toISOString(),
      last: {
        requestVersion: version(7),
        requestedAt: new Date(answeredAt).toISOString(),
        status: "done",
        startedAt: new Date(answeredAt).toISOString(),
        finishedAt: new Date(answeredAt + 3_000).toISOString(),
        accounts: [{ shortId: "aaaaaaaa", updated: true, reason: null }],
        error: null,
      },
    },
  };
  const request = {
    key: REFRESH_REQUEST_KEY,
    value: { schema: REFRESH_REQUEST_SCHEMA },
    deleted: false,
    version: version(7),
    updatedAt: answeredAt,
  };
  const socketPath = join(dir, "d.sock");
  const events = [];
  let usageReads = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "PUT") {
        events.push({ put: JSON.parse(body).value });
        return json(200, { entry: {}, replayed: false });
      }
      if (req.url.endsWith("refresh-request")) {
        events.push("request read");
        return json(200, { entry: request, cursor: null });
      }
      usageReads += 1;
      events.push(`usage read ${usageReads}`);
      // The daemon is draining on the first read, then answers.
      if (usageReads === 1) return json(503, { error: "draining" });
      return json(200, { entry: { key: "omni-route/usage", value: previous }, cursor: null });
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const configPath = write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile: write("token", "local-token"),
      authorizedConnections: [A],
      listen: { port: await freePort() },
      pollIntervalMs: 1_000,
      happy: { socketPath, tokenFile: write("happy", "daemon-token"), artifactId: "art1" },
      refresh: {
        baseUrl: gateway.baseUrl,
        tokenFile: write("omniroute-access-token", GATEWAY_TOKEN),
        requestPollMs: 500,
      },
    })
  );
  const service = startService(t, configPath);
  await waitFor(() => events.some((e) => e.put));
  await waitFor(() => events.filter((e) => e === "request read").length >= 2);
  const firstPut = events.findIndex((e) => e.put);
  assert.ok(events.indexOf("usage read 2") < firstPut, JSON.stringify(events.slice(0, 5)));
  // No request is read, and nothing is published, before the read that succeeds.
  assert.equal(events.slice(0, events.indexOf("usage read 2")).includes("request read"), false);
  assert.deepEqual(events[firstPut].put.refresh, previous.refresh);
  assert.equal(gateway.seen.length, 0, "the answered request is not read again");
  assert.match(service.stdout(), /refresh state not restored: happy kv read returned HTTP 503/);
  assert.match(service.stdout(), /refresh state restored/);
});

// Regression from the fifth independent review of PR #12.

test("a restart after a late timeout whose result was not written keeps a whole interval", async () => {
  // The sync timed out 60 s after it started; its result never reached the store, so the
  // published state is still "running" with the interval counted from the start.
  let resultWritten = true;
  const first = refreshHarness({
    result: { kind: "timeout", delayMs: 60_000 },
    failPublish: (payload) => !resultWritten && payload.refresh.last?.status !== "running",
  });
  resultWritten = false;
  first.refresher.offer(null);
  first.refresher.offer(first.entry(1));
  await first.refresher.idle();
  const published = first.published.at(-1).refresh;
  assert.equal(published.last.status, "running");

  // The service restarts 10 s later.
  const h = refreshHarness();
  h.advance(first.now() - NOW + 10_000);
  const restartedAt = h.now();
  h.refresher.restore(structuredClone(published));
  assert.equal(h.refresher.state().nextAllowedAt, new Date(restartedAt + 120_000).toISOString());
  // Past the interval counted from the start, inside the one counted from the restart.
  h.advance(60_000);
  h.refresher.offer(null);
  h.refresher.offer(h.entry(2));
  await h.refresher.idle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.refresher.state().last.status, "throttled");
});
