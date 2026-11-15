import test from "node:test";
import assert from "node:assert/strict";
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
