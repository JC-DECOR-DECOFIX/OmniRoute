import test from "node:test";
import assert from "node:assert/strict";
import { claude } from "../../src/lib/oauth/providers/claude.ts";

test("continuity OAuth preserves user scopes without granting API-key creation", () => {
  const original = process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY;
  const config = {
    clientId: "synthetic-client",
    redirectUri: "https://example.invalid/callback",
    authorizeUrl: "https://example.invalid/authorize",
    codeChallengeMethod: "S256",
    scopes: ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code"],
  };
  try {
    process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
    const url = new URL(
      claude.buildAuthUrl(config, config.redirectUri, "synthetic-state", "synthetic-challenge")
    );
    assert.deepEqual(url.searchParams.get("scope")?.split(" "), config.scopes.slice(1));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "false";
    const legacy = new URL(
      claude.buildAuthUrl(config, config.redirectUri, "synthetic-state", "synthetic-challenge")
    );
    assert.deepEqual(legacy.searchParams.get("scope")?.split(" "), config.scopes);
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY;
    else process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = original;
  }
});
