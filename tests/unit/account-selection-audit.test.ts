/**
 * EARLIEST_QUOTA_RENEWAL_FIRST — X-OmniRoute-Account-Selection header and the auditable
 * failover / manual-pin events (src/sse/handlers/chat/accountSelectionAudit.ts), plus the
 * chat.ts wiring guarantees (one call site; account switch only before useful output).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-selection-audit-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AMBIENTE = "desenvolvimento";

const core = await import("../../src/lib/db/core.ts");
const events = await import("../../src/lib/db/accountFailoverEvents.ts");
const { finalizeAccountSelection, ACCOUNT_SELECTION_HEADER } =
  await import("../../src/sse/handlers/chat/accountSelectionAudit.ts");

const A = "598035c1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "6726837b-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("stamps the selection reason header on the success response", () => {
  const res = finalizeAccountSelection(new Response("ok"), {
    provider: "claude",
    model: "claude-opus-5-5",
    credentials: {
      connectionId: A,
      accountSelection: "EARLIEST_QUOTA_RENEWAL_FIRST; tier=A; pos=1/2",
    },
    attemptedConnectionIds: [A],
    sessionKey: "claude:s1",
  });
  assert.equal(
    res.headers.get(ACCOUNT_SELECTION_HEADER),
    "EARLIEST_QUOTA_RENEWAL_FIRST; tier=A; pos=1/2"
  );
});

test("non-ASCII or oversized selection text is never echoed", () => {
  const res = finalizeAccountSelection(new Response("ok"), {
    provider: "claude",
    model: null,
    credentials: { connectionId: A, accountSelection: "bad\nheader" },
    attemptedConnectionIds: [A],
  });
  assert.equal(res.headers.get(ACCOUNT_SELECTION_HEADER), null);
});

test("(4) a same-model failover is recorded with from/to/reason/model and a hashed session", () => {
  finalizeAccountSelection(new Response("ok"), {
    provider: "claude",
    model: "claude-opus-5-5",
    credentials: { connectionId: B },
    attemptedConnectionIds: [A, B],
    sessionKey: "claude:0b8e2c1a-4d5f-4a6b-9c7d-1e2f3a4b5c6d",
    lastStatus: 429,
  });
  const [event] = events.listAccountFailoverEvents({ provider: "claude", limit: 1 });
  assert.equal(event.kind, "failover");
  assert.equal(event.fromConnectionId, A);
  assert.equal(event.toConnectionId, B);
  assert.equal(event.reason, "upstream 429");
  assert.equal(event.model, "claude-opus-5-5");
  assert.equal(event.attempts, 2);
  assert.match(String(event.sessionHash), /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(event).includes("0b8e2c1a"), "raw session id never stored");
});

test("(7) an operator pin that moves a session is recorded once as manual_pin", () => {
  const base = { provider: "claude", model: "claude-opus-5-5", sessionKey: "claude:manual" };
  finalizeAccountSelection(new Response("ok"), {
    ...base,
    credentials: { connectionId: A },
    attemptedConnectionIds: [A],
  });
  finalizeAccountSelection(new Response("ok"), {
    ...base,
    credentials: { connectionId: B },
    attemptedConnectionIds: [B],
    forcedConnection: true,
  });
  finalizeAccountSelection(new Response("ok"), {
    ...base,
    credentials: { connectionId: B },
    attemptedConnectionIds: [B],
    forcedConnection: true,
  });
  const manual = events
    .listAccountFailoverEvents({ provider: "claude" })
    .filter((e) => e.kind === "manual_pin");
  assert.equal(manual.length, 1);
  assert.equal(manual[0].fromConnectionId, A);
  assert.equal(manual[0].toConnectionId, B);
});

test("the event log is bounded", () => {
  for (let i = 0; i < events.MAX_ACCOUNT_FAILOVER_EVENTS + 20; i += 1) {
    events.recordAccountFailoverEvent({
      provider: "claude-bound",
      kind: "failover",
      fromConnectionId: A,
      toConnectionId: B,
    });
  }
  const rows = core
    .getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM key_value WHERE namespace = 'account_failover_events'")
    .get() as { n: number };
  assert.ok(rows.n <= events.MAX_ACCOUNT_FAILOVER_EVENTS);
});

test("chat.ts: one audit call in the success branch; account switch only before useful output", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/sse/handlers/chat.ts"), "utf8");
  assert.equal(source.split("finalizeAccountSelection(").length - 1, 1);
  const success = source.indexOf("if (result.success) {");
  assert.ok(success > 0 && source.indexOf("finalizeAccountSelection(", success) - success < 200);
  // The Claude continuity retry is the only path that rotates accounts on a stream
  // failure, and it is documented and gated to "before the first useful output".
  assert.match(source, /This verdict exists only before the first useful output/);
  assert.match(source, /Claude stream interrupted before useful output/);
});
