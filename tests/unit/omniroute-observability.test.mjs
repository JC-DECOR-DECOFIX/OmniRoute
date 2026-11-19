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
  createObserver,
  createPublisher,
  createUsageServer,
  loadConfig,
  readFailure,
  readPrivateFile,
  reportFingerprint,
  sqliteReader,
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
  assert.equal(account(r, C).state, "unavailable");
  assert.equal(account(r, C).stateUntil, null);
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
