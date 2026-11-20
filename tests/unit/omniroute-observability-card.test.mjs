import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CARD_FILE,
  canonical,
  createCardPublisher,
  render,
} from "../../scripts/ops/omniroute-observability/card.mjs";
import {
  cardSettings,
  errorPaths,
  loadConfig,
  readCardArtifact,
  writeCardArtifact,
} from "../../scripts/ops/omniroute-observability/server.mjs";

const FIXTURES = new URL("./fixtures/omniroute-observability/", import.meta.url);
const SERVICE = fileURLToPath(
  new URL("../../scripts/ops/omniroute-observability/server.mjs", import.meta.url)
);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
// The report the approved card v1 was drawn from (19/11/2026 16:42 in São Paulo), anonymized.
const REPORT = fixture("report-2026-11-19.json");
const CARD_V1 = fixture("card-v1.genui.json");
const AT = Date.parse(REPORT.generatedAt);
const NEXT_DAY = Date.parse("2026-11-20T14:00:00.000Z");
const VERSION_1 = "019a0000-0000-7000-8000-000000000001";
const VERSION_2 = "019a0000-0000-7000-8000-000000000002";
const SECRET = "sk-ant-oat01-SECRETSECRETSECRET";

const copy = () => structuredClone(REPORT);
const children = (doc) => doc.root.children;
const table = (doc) => children(doc)[1];
const row = (doc, n) => table(doc).rows[n - 1];
const items = (node) => Object.fromEntries(node.items.map((i) => [i.label, i.value]));

const ICONS = new Set(["user", "clock", "arrow-right"]);
const TONES = new Set(["neutral", "accent", "success", "warning", "danger"]);

/** The Gen UI v1 shape the card uses, with the format's limits; throws on the first problem. */
function assertGenUi(doc) {
  assert.equal(doc.genui, 1);
  assert.equal(typeof doc.fallback, "string");
  assert.ok(doc.fallback.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= 256 * 1024);
  let nodes = 0;
  const badge = (b, where) => {
    assert.equal(typeof b.text, "string", where);
    assert.deepEqual(
      Object.keys(b).filter((k) => !["text", "tone"].includes(k)),
      [],
      where
    );
    if (b.tone !== undefined) assert.ok(TONES.has(b.tone), `${where} tone ${b.tone}`);
  };
  const visit = (node, depth, where) => {
    nodes += 1;
    assert.ok(depth <= 6, `${where} too deep`);
    switch (node.type) {
      case "card":
        assert.equal(typeof node.title, "string");
        assert.equal(node.actions, undefined, "the card has no actions");
        if (node.badge) badge(node.badge, `${where}.badge`);
        node.children.forEach((c, i) => visit(c, depth + 1, `${where}.children[${i}]`));
        break;
      case "keyvalue":
        assert.ok(node.items.length >= 1 && node.items.length <= 12, where);
        for (const item of node.items) {
          assert.equal(typeof item.label, "string", where);
          assert.equal(typeof item.value, "string", where);
          if (item.icon !== undefined) assert.ok(ICONS.has(item.icon), item.icon);
        }
        break;
      case "table": {
        assert.ok(node.columns.length >= 1 && node.columns.length <= 6, where);
        assert.ok(node.rows.length <= 30, where);
        const keys = node.columns.map((c) => c.key);
        for (const r of node.rows) {
          for (const [key, value] of Object.entries(r)) {
            assert.ok(keys.includes(key), `${where} key ${key}`);
            if (typeof value !== "string") badge(value, `${where}.${key}`);
          }
        }
        if (node.caption !== undefined) assert.equal(typeof node.caption, "string");
        break;
      }
      case "text":
        assert.equal(typeof node.text, "string", where);
        if (node.variant !== undefined) assert.equal(node.variant, "caption");
        break;
      default:
        assert.fail(`${where}: unexpected type ${node.type}`);
    }
  };
  visit(doc.root, 1, "root");
  assert.ok(nodes <= 200);
}

test("the 19/11 report renders the approved card v1, apart from the badge and the hours", () => {
  const doc = render(REPORT, AT);
  assertGenUi(doc);
  // v1 was drawn the next day from this report; rendered the same day, these say "hoje" or
  // leave out the date, and the reading is current.
  const expected = structuredClone(CARD_V1);
  expected.root.badge = { text: "Atualizado · 16:38", tone: "success" };
  expected.root.children[0].items[2].value = "16:42:41";
  expected.root.children[1].rows[1].h5z = "hoje 20:29";
  expected.root.children[2].items[0].value = "16:39 · conta 2 → conta 1";
  assert.deepEqual(doc, expected);
});

test("the next day the same report is out of date and the passed 5 h window waits for a reading", () => {
  const doc = render(REPORT, NEXT_DAY);
  assertGenUi(doc);
  assert.deepEqual(doc.root.badge, { text: "Desatualizado · lido 19/11 16:38", tone: "warning" });
  assert.equal(items(children(doc)[0])["Última requisição"], "19/11 16:42:41");
  assert.equal(row(doc, 2).h5, "—");
  assert.equal(row(doc, 2).h5z, "zerou 19/11 20:29 · aguardando leitura");
  assert.equal(items(children(doc)[2])["Última troca"], "19/11 16:39 · conta 2 → conta 1");
  // The 5 h window of the second account is no longer one at the limit.
  assert.equal(
    doc.fallback,
    "Claude · Omni Route, lido 16:38 de 19/11: em uso a conta 1 (one@example.com), semana em 75%, renova sáb 21/11 02:59. Conta 3 com semana em 100% até seg 23/11 02:59."
  );
});

test("crossing midnight in the time zone changes the document", () => {
  const r = copy();
  const before = render(r, Date.parse("2026-11-20T02:59:00.000Z"));
  const after = render(r, Date.parse("2026-11-20T03:01:00.000Z"));
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
  assert.equal(items(children(before)[0])["Última requisição"], "16:42:41");
  assert.equal(items(children(after)[0])["Última requisição"], "19/11 16:42:41");
  // The time zone decides the day, not the machine's.
  const utc = render(r, Date.parse("2026-11-20T02:59:00.000Z"), { timeZone: "UTC" });
  assert.equal(items(children(utc)[0])["Última requisição"], "19/11 19:42:41");
});

test("percentages are tinted at 80 and 95 and reset texts follow the window", () => {
  const r = copy();
  const [one, two, , three] = r.accounts;
  one.quota.windows.weekly.usedPercent = 80;
  two.quota.windows.weekly.usedPercent = 95;
  two.quota.windows.fiveHour.resetsAt = null;
  three.quota.windows.weekly = {
    usedPercent: null,
    state: "reset_pending_reading",
    resetsAt: "2026-11-19T12:00:00.000Z",
    capturedAt: "2026-11-19T11:00:00.000Z",
  };
  // A reset later today reads "hoje".
  one.quota.windows.weekly.resetsAt = "2026-11-19T23:00:00.000Z";
  const doc = render(r, AT);
  assert.deepEqual(row(doc, 1).sem, { text: "80%", tone: "warning" });
  assert.equal(row(doc, 1).semr, "hoje 20:00");
  assert.deepEqual(row(doc, 2).sem, { text: "95%", tone: "danger" });
  assert.equal(row(doc, 2).h5z, "não informada");
  assert.equal(row(doc, 3).sem, "—");
  assert.equal(row(doc, 3).semr, "renovou 09:00 · aguardando leitura");
  assert.deepEqual(row(doc, 3).estado, { text: "Desatualizado", tone: "warning" });
  assert.equal(row(doc, 3).h5, "—");
  assert.equal(row(doc, 3).h5z, "—");
});

test("account states follow the panel", () => {
  const r = copy();
  const [, two, , three] = r.accounts;
  two.state = "cooldown";
  two.stateUntil = "2026-11-19T20:10:00.000Z";
  three.quota.status = "fresh";
  three.inUse = false;
  let doc = render(r, AT);
  assert.deepEqual(row(doc, 2).estado, { text: "Em espera até 17:10", tone: "warning" });
  assert.deepEqual(row(doc, 3).estado, { text: "Ociosa" });
  // Without a confirmed reading nothing is shown and the account is unavailable.
  three.quota.status = "unavailable";
  doc = render(r, AT);
  assert.deepEqual(
    [row(doc, 3).h5, row(doc, 3).h5z, row(doc, 3).sem, row(doc, 3).semr, row(doc, 3).estado],
    ["—", "—", "—", "—", { text: "Indisponível" }]
  );
});

test("the caption names only what applies", () => {
  const r = copy();
  for (const a of r.accounts) {
    if (a.authorized)
      a.quota.windows.fiveHour = structuredClone(r.accounts[1].quota.windows.fiveHour);
  }
  r.accounts = r.accounts.filter((a) => a.authorized);
  const doc = render(r, AT);
  assert.equal(table(doc).caption, undefined);
  const two = copy();
  two.accounts.push({
    ...structuredClone(two.accounts[2]),
    connectionId: "eeeeeeee-0",
    shortId: "eeeeeeee",
    email: "four@example.com",
    testStatus: "active",
    state: "active",
  });
  assert.equal(
    table(render(two, AT)).caption,
    "“—”: a Anthropic não informou a janela de 5 h dessa conta. Fora do pool: old@example.com, expirada; four@example.com, fora da lista autorizada."
  );
});

test("without switches or a current account the card says so", () => {
  const r = copy();
  r.switches = [];
  r.current = null;
  const doc = render(r, AT);
  assertGenUi(doc);
  assert.deepEqual(children(doc)[0].items, [
    { label: "Em uso agora", value: "Nenhuma requisição recente", icon: "user" },
  ]);
  assert.deepEqual(children(doc)[2].items, [
    { label: "Última troca", value: "Nenhuma nos últimos 7 dias", icon: "arrow-right" },
  ]);
  // The panel's badge is the active account's reading; with none, it is unavailable.
  assert.deepEqual(doc.root.badge, { text: "Indisponível" });
  assert.match(doc.fallback, /: nenhuma requisição recente\./);
});

test("a switch to another model or one that failed says so", () => {
  const r = copy();
  r.switches[0].effectiveModel = "claude-sonnet-5";
  r.switches[0].outcome = "failed";
  r.switches[0].reason = { status: 502, summary: "Stream ended before producing any content" };
  const kv = items(children(render(r, AT))[2]);
  assert.equal(kv.Motivo, "502 · stream terminou sem resposta");
  assert.equal(kv.Resultado, "modelo efetivo claude-sonnet-5, falhou");
});

test("an unavailable or malformed report renders a single line", () => {
  const unavailable = copy();
  unavailable.observer.status = "unavailable";
  for (const report of [unavailable, null, {}, { ...copy(), accounts: "x" }]) {
    const doc = render(report, AT);
    assertGenUi(doc);
    assert.deepEqual(doc.root.badge, { text: "Indisponível" });
    assert.deepEqual(doc.root.children, [
      { type: "text", text: "Relatório do Omni Route indisponível no momento" },
    ]);
  }
});

test("no credential that reached the report is shown, in the card or its fallback", () => {
  const r = copy();
  r.current.requestedModel = "oma_abcdefghij0123456789";
  r.current.effectiveModel = SECRET;
  r.switches[0].requestedModel = "token=abc123";
  r.switches[0].effectiveModel = "Bearer abc.def";
  r.switches[0].reason = { status: 401, summary: `upstream said ${SECRET}` };
  const doc = render(r, AT);
  assertGenUi(doc);
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /oma_|sk-ant|Bearer |token=/);
  assert.match(text, /\[redacted\]/);
  assert.doesNotMatch(doc.fallback, /oma_|sk-ant|Bearer |token=/);
});

test("without a confirmed reading the fallback does not change with each poll", () => {
  const r = copy();
  r.current = null;
  const later = copy();
  later.current = null;
  later.generatedAt = new Date(AT + 15_000).toISOString();
  const doc = render(r, AT);
  assert.deepEqual(render(later, AT), doc);
  assert.match(doc.fallback, /^Claude · Omni Route, sem leitura confirmada de cota: /);
});

test("the footer names the configured interval", () => {
  const text = (ms) => children(render(REPORT, AT, { minIntervalMs: ms }))[3].text;
  assert.match(text(300_000), /no máximo a cada 5 min$/);
  assert.match(text(90_000), /no máximo a cada 90 s$/);
});

// Publishing policy.

function publisherHarness({ latest, results = [], readFails = 0 } = {}) {
  let clock = AT;
  const reads = [];
  const writes = [];
  const logs = [];
  let failures = readFails;
  const publish = createCardPublisher({
    read: async () => {
      reads.push(clock);
      if (failures > 0) {
        failures -= 1;
        throw new Error("happy card read returned HTTP 503");
      }
      return latest();
    },
    write: async (fields) => {
      writes.push({ ...fields, at: clock });
      const next = results.shift() ?? { status: 200, version: VERSION_2 };
      if (next instanceof Error) throw next;
      return next;
    },
    minIntervalMs: 300_000,
    now: () => clock,
    log: (message) => logs.push(message),
  });
  return { publish, reads, writes, logs, advance: (ms) => (clock += ms) };
}

const docA = render(REPORT, AT);
const docB = render(REPORT, NEXT_DAY);

test("the same document is never written again, even after a restart", async () => {
  const h = publisherHarness({
    latest: () => ({
      version: VERSION_1,
      updatedAt: AT - 3_600_000,
      text: JSON.stringify(docA, null, 2),
    }),
  });
  assert.equal(await h.publish(docA), "unchanged");
  h.advance(600_000);
  assert.equal(await h.publish(docA), "unchanged");
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.length, 1, "the artifact is read once");
});

test("a changed document waits for the interval, counted from the artifact's last change", async () => {
  const h = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: AT - 60_000, text: JSON.stringify(docA) }),
  });
  assert.equal(await h.publish(docB), "waiting");
  h.advance(239_000);
  assert.equal(await h.publish(docB), "waiting");
  h.advance(1_000);
  assert.equal(await h.publish(docB), "written");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].version, VERSION_1);
  assert.deepEqual(JSON.parse(h.writes[0].text), docB);
  assert.match(h.writes[0].mutationId, /^card-\d+-1$/);
  // The next change waits a whole interval after this write, with the new version.
  assert.equal(await h.publish(docA), "waiting");
  h.advance(300_000);
  assert.equal(await h.publish(docA), "written");
  assert.equal(h.writes[1].version, VERSION_2);
  assert.deepEqual(h.logs, ["card published", "card published"]);
});

test("a conflict reloads the artifact before the next write", async () => {
  let version = VERSION_1;
  const h = publisherHarness({
    latest: () => ({ version, updatedAt: AT - 600_000, text: JSON.stringify(docA) }),
    results: [{ status: 409 }, { status: 200, version: VERSION_2 }],
  });
  assert.equal(await h.publish(docB), "conflict");
  version = "019a0000-0000-7000-8000-00000000000a";
  assert.equal(await h.publish(docB), "written");
  assert.equal(h.reads.length, 2);
  assert.equal(h.writes[1].version, version);
  // A 412 is handled the same way.
  const p = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: null, text: "" }),
    results: [{ status: 412 }],
  });
  assert.equal(await p.publish(docA), "conflict");
  assert.equal(await p.publish(docA), "written");
  assert.equal(p.reads.length, 2);
});

test("a refused document is not sent again, and only its error code and paths are logged", async () => {
  const h = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: null, text: "" }),
    results: [{ status: 400, errorCode: "invalid_request", paths: ["/root/children/1/rows/0"] }],
  });
  assert.equal(await h.publish(docA), "refused");
  h.advance(3_600_000);
  assert.equal(await h.publish(docA), "refused");
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.logs, ["card refused: HTTP 400 invalid_request at /root/children/1/rows/0"]);
  // Another document is tried.
  assert.equal(await h.publish(docB), "written");
});

test("documents refused in turn are none of them sent again", async () => {
  const refusal = { status: 400, errorCode: "invalid_request", paths: [] };
  const h = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: null, text: "" }),
    results: [refusal, refusal],
  });
  assert.equal(await h.publish(docA), "refused");
  assert.equal(await h.publish(docB), "refused");
  h.advance(3_600_000);
  assert.equal(await h.publish(docA), "refused");
  assert.equal(await h.publish(docB), "refused");
  assert.equal(h.writes.length, 2);
});

test("more than 32 refusals never cause the first document to be retried", async () => {
  const refusal = { status: 400, errorCode: "invalid_request" };
  const documents = Array.from({ length: 33 }, (_, i) => ({ ...docA, fallback: `Cota ${i}` }));
  const h = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: null, text: "" }),
    results: documents.map(() => refusal),
  });
  for (const doc of documents) assert.equal(await h.publish(doc), "refused");

  const { fallback, ...first } = documents[0];
  assert.equal(await h.publish({ fallback, ...first }), "refused");
  assert.equal(h.writes.length, 33);
  assert.equal(await h.publish(docB), "written");
});

test("the same document with its keys in another order is unchanged", async () => {
  const reversed = (value) => {
    if (Array.isArray(value)) return value.map(reversed);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((k) => [k, reversed(value[k])])
    );
  };
  const text = JSON.stringify(reversed(docA), null, 2);
  assert.notEqual(text, JSON.stringify(docA, null, 2));
  assert.equal(canonical(text), canonical(JSON.stringify(docA)));
  // Arrays keep their order.
  assert.notEqual(canonical("[1,2]"), canonical("[2,1]"));
  const h = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: AT - 3_600_000, text }),
  });
  assert.equal(await h.publish(docA), "unchanged");
  assert.equal(h.writes.length, 0);
});

test("failures are logged once, retried on the next call, and never thrown", async () => {
  const h = publisherHarness({
    latest: () => ({ version: VERSION_1, updatedAt: null, text: "not json" }),
    readFails: 2,
    results: [new Error("happy kv write timed out"), { status: 503 }],
  });
  assert.equal(await h.publish(docA), "failed");
  assert.equal(await h.publish(docA), "failed");
  assert.equal(await h.publish(docA), "failed");
  assert.equal(await h.publish(docA), "failed");
  assert.equal(await h.publish(docA), "written");
  assert.deepEqual(h.logs, [
    "card state not read: happy card read returned HTTP 503",
    "card publish failed: happy kv write timed out",
    "card publish failed: HTTP 503",
    "card published",
  ]);
  assert.equal(canonical("not json"), null);
});

test("error paths keep node paths of the sent document only", () => {
  const sent = JSON.stringify(CARD_V1);
  const body = {
    error: `root<card>.children[1]<table>.rows[0].h5: expected string; root<card>.badge.${SECRET.replace(/-/g, "_")}: bad; root<card>.children[0]<keyvalue>.items[2].value: ${SECRET}`,
    code: "invalid_request",
    details: [
      { path: "/root/children/1/rows/0/h5", message: `value ${SECRET}` },
      { instancePath: "/root/badge", value: SECRET },
      { path: `x ${SECRET}` },
      { pointer: "/root/SECRETSECRET" },
    ],
  };
  assert.deepEqual(errorPaths(body, sent), [
    "root<card>.children[1]<table>.rows[0].h5",
    "root<card>.children[0]<keyvalue>.items[2].value",
    "/root/children/1/rows/0/h5",
    "/root/badge",
  ]);
  assert.deepEqual(errorPaths(body, "not json"), []);
  assert.deepEqual(errorPaths(null, sent), []);
});

// Configuration and the daemon calls.

function privateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "obs-card-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  return { dir, write };
}

test("the card configuration is validated", (t) => {
  const { dir, write } = privateDir(t);
  const base = {
    dbPath: join(dir, "db.sqlite"),
    tokenFile: join(dir, "token"),
    happy: { socketPath: join(dir, "s.sock"), tokenFile: join(dir, "happy"), artifactId: "art1" },
  };
  const config = (value) => loadConfig(write("config.json", JSON.stringify(value)));
  assert.equal(cardSettings(config(base)), null);
  assert.deepEqual(cardSettings(config({ ...base, card: { artifactId: "pww9b30x" } })), {
    artifactId: "pww9b30x",
    minIntervalMs: 300_000,
    timeZone: "America/Sao_Paulo",
  });
  const bad = [
    [{ artifactId: "../x" }, /artifactId/],
    [{}, /artifactId/],
    [{ artifactId: "a", minIntervalMs: 59_999 }, /minIntervalMs/],
    [{ artifactId: "a", minIntervalMs: 86_400_001 }, /minIntervalMs/],
    [{ artifactId: "a", minIntervalMs: null }, /minIntervalMs/],
    [{ artifactId: "a", timeZone: "Mars/Olympus" }, /timeZone/],
    [{ artifactId: "a", timeZone: null }, /timeZone/],
  ];
  for (const [card, error] of bad) assert.throws(() => config({ ...base, card }), error);
  assert.throws(() => config({ ...base, card: [] }), /card/);
  assert.throws(() => config({ ...base, happy: undefined, card: { artifactId: "a" } }), /happy/);
});

/** A fake Happy daemon serving one Gen UI artifact and the data store. */
async function fakeDaemon(t, dir, { updatedAt = Date.now() - 3_600_000, text = "{}" } = {}) {
  const socketPath = join(dir, "d.sock");
  const requests = [];
  const artifact = {
    id: "card1",
    type: "gen_ui",
    status: "active",
    latestVersion: 1,
    version: VERSION_1,
    updatedAt,
  };
  let file = text;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url.includes("/api/v1/kv/")) {
        if (req.method === "GET") return json(200, { entry: null, cursor: null });
        return json(200, { entry: {}, replayed: false });
      }
      if (req.url === "/v0/artifacts/card1" && req.method === "GET") return json(200, { artifact });
      if (req.url === `/v0/artifacts/card1/versions/${artifact.latestVersion}/files/${CARD_FILE}`) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(file);
      }
      if (req.url === "/v0/artifacts/card1" && req.method === "PATCH") {
        if (req.headers["if-match"] !== artifact.version) {
          return json(409, { code: "conflict", currentVersion: artifact.version });
        }
        const parsed = JSON.parse(body);
        file = parsed.files[0].text;
        artifact.latestVersion += 1;
        artifact.version = `019a0000-0000-7000-8000-00000000000${artifact.latestVersion}`;
        artifact.updatedAt = Date.now();
        return json(200, { artifact });
      }
      json(404, { code: "not_found" });
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { socketPath, requests, artifact, file: () => file };
}

test("the daemon calls read the numbered version and write with an unquoted If-Match", async (t) => {
  const { dir } = privateDir(t);
  const daemon = await fakeDaemon(t, dir, { updatedAt: 1_000, text: '{"genui":1}' });
  const args = { socketPath: daemon.socketPath, token: "daemon-token", artifactId: "card1" };
  assert.deepEqual(await readCardArtifact(args), {
    version: VERSION_1,
    updatedAt: 1_000,
    text: '{"genui":1}',
  });
  const written = await writeCardArtifact({
    ...args,
    version: VERSION_1,
    text: '{"genui":1,"x":2}\n',
    mutationId: "card-1-1",
  });
  assert.equal(written.status, 200);
  assert.equal(written.version, "019a0000-0000-7000-8000-000000000002");
  const patch = daemon.requests.find((r) => r.method === "PATCH");
  assert.equal(patch.headers["if-match"], VERSION_1);
  assert.equal(patch.headers.authorization, "Bearer daemon-token");
  assert.deepEqual(JSON.parse(patch.body), {
    mutationId: "card-1-1",
    files: [{ path: CARD_FILE, text: '{"genui":1,"x":2}\n' }],
  });
  // A stale version is a conflict; a version that is not one is never sent.
  assert.equal(
    (await writeCardArtifact({ ...args, version: VERSION_1, text: "{}", mutationId: "m" })).status,
    409
  );
  await assert.rejects(
    writeCardArtifact({ ...args, version: `${VERSION_1}\r\nx: y`, text: "{}", mutationId: "m" }),
    /not a version/
  );
});

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitFor(predicate, ms = 8_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

function startService(t, configPath) {
  const child = spawn(process.execPath, [SERVICE, configPath]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  t.after(() => child.kill("SIGKILL"));
  return { stdout: () => stdout, stderr: () => stderr };
}

function serviceConfig(write, dir, socketPath, card) {
  return write(
    "config.json",
    JSON.stringify({
      dbPath: join(dir, "missing.sqlite"),
      tokenFile: write("token", "local-token"),
      listen: { port: 0 },
      pollIntervalMs: 1_000,
      happy: { socketPath, tokenFile: write("happy", "daemon-token"), artifactId: "panel1" },
      card,
    })
  );
}

test("the service publishes the card once and then only when it changes", async (t) => {
  const { dir, write } = privateDir(t);
  const daemon = await fakeDaemon(t, dir);
  const configPath = serviceConfig(write, dir, daemon.socketPath, {
    artifactId: "card1",
    minIntervalMs: 60_000,
  });
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.listen.port = await freePort();
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const service = startService(t, configPath);
  await waitFor(() => daemon.requests.some((r) => r.method === "PATCH"));
  // Several ticks later the same document has not been written again.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const patches = daemon.requests.filter((r) => r.method === "PATCH");
  assert.equal(patches.length, 1);
  const doc = JSON.parse(daemon.file());
  assertGenUi(doc);
  // No database: the report is unavailable, and the card says so.
  assert.equal(doc.root.children[0].text, "Relatório do Omni Route indisponível no momento");
  assert.match(service.stdout(), /card published/);
  // The panel's data store still gets the report.
  assert.ok(
    daemon.requests.some((r) => r.method === "PUT" && r.url.includes("omni-route%2Fusage"))
  );
  const logs = service.stdout() + service.stderr();
  for (const needle of ["daemon-token", "oma_", "sk-ant", "Bearer "]) {
    assert.equal(logs.includes(needle), false, needle);
  }
});

test("an active non-Gen UI artifact is never patched and does not stop panel publishing", async (t) => {
  const { dir, write } = privateDir(t);
  const daemon = await fakeDaemon(t, dir);
  daemon.artifact.type = "html";
  const configPath = serviceConfig(write, dir, daemon.socketPath, { artifactId: "card1" });
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.listen.port = await freePort();
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const service = startService(t, configPath);
  const rejected = () => service.stdout().includes("happy card artifact is not active Gen UI");
  await waitFor(() => rejected() || daemon.requests.some((r) => r.method === "PATCH"));
  assert.ok(rejected());
  await waitFor(() =>
    daemon.requests.some((r) => r.method === "PUT" && r.url.includes("omni-route%2Fusage"))
  );
  assert.ok(
    daemon.requests
      .filter((r) => r.url.startsWith("/v0/artifacts/card1"))
      .every((r) => r.method === "GET" && r.url === "/v0/artifacts/card1")
  );
});

test("after a restart the card is not written before the interval from its last change", async (t) => {
  const { dir, write } = privateDir(t);
  const daemon = await fakeDaemon(t, dir, { updatedAt: Date.now() - 1_000, text: "{}" });
  const configPath = serviceConfig(write, dir, daemon.socketPath, { artifactId: "card1" });
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.listen.port = await freePort();
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  startService(t, configPath);
  await waitFor(() => daemon.requests.some((r) => r.url.endsWith(CARD_FILE)));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(daemon.requests.filter((r) => r.method === "PATCH").length, 0);
});
