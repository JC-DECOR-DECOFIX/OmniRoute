/**
 * (11) Session identifiers for per-session account affinity.
 * Claude Code (terminal, VS Code) and both Happy harnesses run the Claude Code binary, which
 * sends the same session UUID as `X-Claude-Code-Session-Id` and inside `metadata.user_id`.
 * All identifiers below are synthetic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc-session-key-"));

const { extractClaudeCodeSessionId, parseClaudeCodeUserIdSession } =
  await import("../../src/sse/services/claudeCodeSessionKey.ts");
const { extractSessionAffinityKey } = await import("../../src/sse/services/auth.ts");

const SESSION = "0b8e2c1a-4d5f-4a6b-9c7d-1e2f3a4b5c6d";
const DEVICE = "a".repeat(64);
const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const headers = (entries: Record<string, string>) => new Headers(entries);
const body = (userId: string | undefined, text = "first prompt") => ({
  model: "claude-opus-5-5",
  metadata: userId === undefined ? {} : { user_id: userId },
  messages: [{ role: "user", content: text }],
});

test("JSON metadata.user_id (current CLI and Agent SDK) yields the session UUID only", () => {
  const userId = JSON.stringify({ device_id: DEVICE, account_uuid: ACCOUNT, session_id: SESSION });
  assert.equal(parseClaudeCodeUserIdSession(userId), SESSION);
});

test("legacy metadata.user_id yields the session UUID only", () => {
  assert.equal(
    parseClaudeCodeUserIdSession(`user_${DEVICE}_account_${ACCOUNT}_session_${SESSION}`),
    SESSION
  );
});

test("malformed or oversized user_id is ignored", () => {
  assert.equal(parseClaudeCodeUserIdSession("{not json"), null);
  assert.equal(parseClaudeCodeUserIdSession(JSON.stringify({ session_id: "not-a-uuid" })), null);
  assert.equal(parseClaudeCodeUserIdSession("x".repeat(5000)), null);
  assert.equal(parseClaudeCodeUserIdSession(42), null);
});

test("header and body give the same affinity key, independent of the prompt", () => {
  const userId = JSON.stringify({ device_id: DEVICE, account_uuid: ACCOUNT, session_id: SESSION });
  const fromHeader = extractSessionAffinityKey(
    body(undefined, "a"),
    headers({ "x-claude-code-session-id": SESSION.toUpperCase() })
  );
  const fromBody = extractSessionAffinityKey(body(userId, "b"), headers({}));
  const laterTurn = extractSessionAffinityKey(body(userId, "c — another turn"), headers({}));
  assert.equal(fromHeader, `claude:${SESSION}`);
  assert.equal(fromBody, fromHeader);
  assert.equal(laterTurn, fromHeader);
  assert.ok(!String(fromBody).includes(DEVICE) && !String(fromBody).includes(ACCOUNT));
});

test("Happy claude_code (sdk-cli) and Happy own harness requests resolve the same way", () => {
  // Both Happy providers execute the Claude Code binary through claude-happy-gateway.
  for (const entrypoint of ["sdk-cli", "sdk-ts"]) {
    const key = extractSessionAffinityKey(
      body(JSON.stringify({ device_id: DEVICE, account_uuid: "", session_id: SESSION })),
      headers({
        "user-agent": `claude-cli/2.1.321 (external, ${entrypoint})`,
        "x-claude-code-session-id": SESSION,
      })
    );
    assert.equal(key, `claude:${SESSION}`);
  }
});

test("explicit OmniRoute session headers keep precedence; no identifier falls back to the input hash", () => {
  assert.equal(
    extractSessionAffinityKey(
      body(undefined),
      headers({ "x-session-id": "ops-1", "x-claude-code-session-id": SESSION })
    ),
    "header:ops-1"
  );
  assert.equal(extractClaudeCodeSessionId(body(undefined), headers({})), null);
  assert.match(String(extractSessionAffinityKey(body(undefined), headers({}))), /^input:sha256:/);
});
