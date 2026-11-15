import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-continuity-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const db = await import("../../src/lib/db/providers.ts");
const core = await import("../../src/lib/db/core.ts");
const tokens = await import("../../open-sse/services/tokenRefresh.ts");
const { runWithCasGuard, RefreshCredentialConflictError } =
  await import("../../open-sse/services/tokenRefresh/casGuard.ts");
const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("metadata concurrent with refresh cannot restore the old credential pair", async () => {
  const conn = await db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "synthetic",
    accessToken: "access-before",
    refreshToken: "refresh-before",
    isActive: true,
  });
  await Promise.all([
    db.updateProviderConnection(conn.id, {
      accessToken: "access-new",
      refreshToken: "refresh-new",
    }),
    db.updateProviderConnection(conn.id, { lastUsedAt: new Date().toISOString() }),
  ]);
  const latest = await db.getProviderConnectionById(conn.id);
  assert.equal(latest.accessToken, "access-new");
  assert.equal(latest.refreshToken, "refresh-new");
  assert.ok(latest.lastUsedAt);
});

test("Claude invalid_request does not claim that the refresh token was consumed", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
  const result = await tokens.refreshClaudeOAuthToken("synthetic-refresh", null);
  assert.equal(tokens.isUnrecoverableRefreshError(result), false);
  assert.equal(result?.error, "refresh_request_rejected");
});

test("Claude refresh expiration retains its original reason", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Refresh token expired",
      }),
      { status: 400 }
    );
  const result = await tokens.refreshClaudeOAuthToken("synthetic-refresh", null);
  assert.equal(result?.code, "invalid_grant");
  assert.equal(result?.reason, "refresh_token_expired");
});

test("concurrent refreshes share one network rotation and persist the pair once", async () => {
  const conn = await db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    accessToken: "concurrent-access",
    refreshToken: "concurrent-refresh",
    isActive: true,
  });
  let calls = 0;
  let persisted = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        access_token: "concurrent-new-access",
        refresh_token: "concurrent-new-refresh",
        expires_in: 3600,
      })
    );
  };
  const credentials = {
    connectionId: conn.id,
    accessToken: "concurrent-access",
    refreshToken: "concurrent-refresh",
  };
  const persist = async (result: Record<string, unknown>) => {
    persisted++;
    await db.updateProviderConnection(conn.id, result);
  };
  const [a, b] = await Promise.all([
    tokens.getAccessToken("claude", { ...credentials }, null, null, persist),
    tokens.getAccessToken("claude", { ...credentials }, null, null, persist),
  ]);
  assert.equal(calls, 1);
  assert.equal(persisted, 1);
  assert.equal(a?.accessToken, b?.accessToken);
  const latest = await db.getProviderConnectionById(conn.id);
  assert.equal(latest.accessToken, "concurrent-new-access");
  assert.equal(latest.refreshToken, "concurrent-new-refresh");
});

test("a late refresh cannot overwrite a newer login and returns the current pair", async () => {
  const conn = await db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    accessToken: "late-access",
    refreshToken: "late-refresh",
    isActive: true,
  });
  let started!: () => void;
  let finish!: (value: Response) => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async () => {
    started();
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  const refresh = tokens.getAccessToken(
    "claude",
    {
      connectionId: conn.id,
      accessToken: "late-access",
      refreshToken: "late-refresh",
    },
    null,
    null,
    async (result) => {
      await db.updateProviderConnection(conn.id, result);
    }
  );
  await ready;
  await db.updateProviderConnection(conn.id, {
    accessToken: "login-access",
    refreshToken: "login-refresh",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  finish(
    new Response(
      JSON.stringify({
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_in: 3600,
      })
    )
  );
  const result = await refresh;
  assert.equal(result?.accessToken, "login-access");
  assert.equal(result?.refreshPersistenceHandled, true);
  const latest = await db.getProviderConnectionById(conn.id);
  assert.equal(latest.accessToken, "login-access");
  assert.equal(latest.refreshToken, "login-refresh");
});

test("a late authentication failure cannot deactivate a new access token with the same refresh token", async () => {
  const conn = await db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    accessToken: "old-access",
    refreshToken: "same-refresh",
    isActive: true,
  });
  await db.updateProviderConnection(conn.id, { accessToken: "new-access" });
  await assert.rejects(
    () =>
      runWithCasGuard(
        {
          connectionId: conn.id,
          expectedRefreshToken: "same-refresh",
          expectedAccessToken: "old-access",
          reread: async () => "same-refresh",
        },
        () => db.updateProviderConnection(conn.id, { isActive: false, testStatus: "expired" })
      ),
    RefreshCredentialConflictError
  );
  const latest = await db.getProviderConnectionById(conn.id);
  assert.equal(latest.isActive, true);
  assert.equal(latest.accessToken, "new-access");
});
