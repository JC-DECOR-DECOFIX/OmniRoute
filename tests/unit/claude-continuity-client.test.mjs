import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gatewayEnvironment } from "../../scripts/ops/claude-continuity-client.mjs";

const config = {
  base_url: "http://127.0.0.1:20128",
  gateway_key: "synthetic-gateway",
  allowed_connections: ["account-A", "account-B"],
};
test("AUTO removes inherited account pins and native API credentials", () => {
  const base = {
    ANTHROPIC_API_KEY: "synthetic-native",
    ANTHROPIC_CUSTOM_HEADERS: "Other: keep\n x-omniroute-connection : old-account",
  };
  const env = gatewayEnvironment(base, config);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "Other: keep");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "synthetic-gateway");
  assert.equal(base.ANTHROPIC_API_KEY, "synthetic-native");
});
test("a fixed account remains explicit and constrained to its pool", () => {
  assert.equal(
    gatewayEnvironment({}, { ...config, fixed_connection_id: "account-A" })
      .ANTHROPIC_CUSTOM_HEADERS,
    "x-omniroute-connection: account-A"
  );
  assert.throws(() => gatewayEnvironment({}, { ...config, fixed_connection_id: "outside" }));
  assert.throws(() => gatewayEnvironment({}, { ...config, base_url: "https://external.invalid" }));
});

test("a symlink entry executes Claude and propagates its exit without hanging", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-continuity-entry-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    chmodSync(configPath, 0o600);
    const link = join(dir, "claude-continuity");
    symlinkSync(resolve("scripts/ops/claude-continuity-client.mjs"), link);
    const marker = join(dir, "executed");
    const result = spawnSync(
      process.execPath,
      [
        link,
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'executed'); process.exit(7)",
        marker,
      ],
      {
        env: { ...process.env, CLAUDE_CONTINUITY_CONFIG: configPath },
        timeout: 3000,
      }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
