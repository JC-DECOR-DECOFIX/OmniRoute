#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Same AUTO/header contract as jc-mission-worker's ambiente_omniroute.
export function gatewayEnvironment(base, config) {
  const url = new URL(config.base_url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("Continuity gateway must be this Mac's loopback endpoint");
  }
  if (typeof config.gateway_key !== "string" || !/^[\x21-\x7e]{8,512}$/.test(config.gateway_key)) {
    throw new Error("Continuity gateway credential is missing or malformed");
  }
  const env = {
    ...base,
    ANTHROPIC_BASE_URL: config.base_url,
    ANTHROPIC_AUTH_TOKEN: config.gateway_key,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const headers = (env.ANTHROPIC_CUSTOM_HEADERS || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*x-omniroute-connection\s*:/i.test(line));
  if (config.fixed_connection_id) {
    if (
      !config.allowed_connections?.includes(config.fixed_connection_id) ||
      !/^[a-zA-Z0-9-]+$/.test(config.fixed_connection_id)
    ) {
      throw new Error("Fixed account is outside the authorized continuity pool");
    }
    headers.push(`x-omniroute-connection: ${config.fixed_connection_id}`);
  }
  if (headers.join("\n").trim()) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n").trim();
  else delete env.ANTHROPIC_CUSTOM_HEADERS;
  return env;
}

function main() {
  const configPath =
    process.env.CLAUDE_CONTINUITY_CONFIG ||
    join(homedir(), ".omniroute", "claude-continuity-client.json");
  const stat = statSync(configPath);
  if (stat.mode & 0o077 || stat.uid !== process.getuid()) {
    throw new Error("Continuity client configuration must belong to this user and have mode 0600");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  // VS Code's claudeProcessWrapper passes the bundled Claude binary as arg 1.
  const binary =
    args[0] && isAbsolute(args[0]) ? args.shift() : join(homedir(), ".local", "bin", "claude");
  const child = spawn(binary, args, {
    env: gatewayEnvironment(process.env, config),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.on("error", () => {
    console.error("Could not start the configured Claude Code binary");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    console.error(
      "Claude continuity client is unavailable; verify its private configuration and gateway"
    );
    process.exitCode = 1;
  }
}
