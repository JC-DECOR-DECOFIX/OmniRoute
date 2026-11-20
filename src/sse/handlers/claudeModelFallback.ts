/**
 * Model fallback for the Claude account-continuity pool.
 *
 * Under `OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY=true` a Claude request keeps its model: when no
 * authorized account can serve it, the pool answers `upstream_accounts_unavailable` (chat.ts).
 * This module adds one configured exception. When the pool is unavailable for the requested model
 * only because every eligible account is rate-limited for it (HTTP 429, including the cached
 * cooldown that answers without any upstream call), the same request is sent once more for the
 * next model of `OMNIROUTE_CLAUDE_MODEL_FALLBACK_CHAIN`, through the same authorized pool,
 * priority order and per-model cooldowns.
 *
 * An independently opt-in Messages policy may extend this to proven upstream account outages.
 * It walks the same Claude chain before making a single terminal Codex hop. Local pressure,
 * request errors and emitted output are not evidence of an exhausted pool.
 */

import { getModelSpec } from "@/shared/constants/modelSpecs.ts";
import type { TerminalReason } from "../services/claudeTerminalPool";
import * as log from "../utils/logger";

/** The JC installation's default chain, used when the variable is not set. */
const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
export const DEFAULT_CLAUDE_MODEL_FALLBACK_CHAIN = `${FABLE}>${OPUS}`;

export function isClaudeTerminalSource(model: unknown): model is typeof FABLE | typeof OPUS {
  return model === FABLE || model === OPUS;
}

/** Response headers that name the model that actually answered. */
export const EFFECTIVE_MODEL_HEADER = "X-OmniRoute-Effective-Model";
export const MODEL_FALLBACK_HEADER = "X-OmniRoute-Model-Fallback";

export type ClaudeModelFallback = {
  from: string;
  to: string;
  reason: TerminalReason;
  provider?: "codex";
};

type JsonRecord = Record<string, unknown>;
type PoolRateLimit = { body: JsonRecord; continuity: JsonRecord };
export const CLAUDE_TERMINAL_TARGET = "codex/gpt-6.2-sol";
const terminalPools = new WeakMap<Response, { model: string; reason: TerminalReason }>();

export function markClaudeTerminalPool(
  response: Response,
  model: string,
  reason: TerminalReason
): void {
  if (isClaudeTerminalSource(model)) terminalPools.set(response, { model, reason });
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/i;
const DISABLED = /^(?:off|none|false|0)$/i;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/**
 * Parse `from>to[>next...]` links separated by commas into a model → next-model map.
 * Unset means the default chain; an empty value or `off`/`none` disables the fallback.
 * Malformed links and a second link for the same source model are ignored.
 */
export function parseClaudeModelFallbackChain(raw: string | undefined): Map<string, string> {
  const chain = new Map<string, string>();
  const source = raw === undefined ? DEFAULT_CLAUDE_MODEL_FALLBACK_CHAIN : raw.trim();
  if (!source || DISABLED.test(source)) return chain;
  for (const entry of source.split(",")) {
    const models = entry.split(">").map((part) => part.trim().toLowerCase());
    if (models.length < 2 || !models.every((model) => MODEL_ID.test(model))) continue;
    for (let index = 0; index < models.length - 1; index++) {
      const [from, to] = [models[index], models[index + 1]];
      if (from !== to && !chain.has(from)) chain.set(from, to);
    }
  }
  return chain;
}

/** The continuity error body of a pool whose every eligible account is rate-limited. */
async function readPoolRateLimit(response: Response): Promise<PoolRateLimit | null> {
  if (
    response.status !== 429 ||
    response.headers.get("x-omniroute-continuity-status") !== "accounts-unavailable"
  ) {
    return null;
  }
  const pool = await readPoolAnswer(response);
  if (
    !pool ||
    (pool.continuity.local_status ?? pool.continuity.upstream_status) !== 429 ||
    pool.continuity.pool_rate_limited !== true
  ) {
    return null;
  }
  return pool;
}

async function readPoolAnswer(response: Response): Promise<PoolRateLimit | null> {
  if (response.headers.get("x-omniroute-continuity-status") !== "accounts-unavailable") return null;
  let body: JsonRecord | null = null;
  try {
    body = asRecord(JSON.parse(await response.clone().text()));
  } catch {
    return null;
  }
  const continuity = asRecord(body?.continuity);
  if (
    !body ||
    !continuity ||
    continuity.provider !== "claude" ||
    continuity.mode !== "authorized-pool" ||
    typeof continuity.requested_model !== "string" ||
    !MODEL_ID.test(continuity.requested_model)
  ) {
    return null;
  }
  return { body, continuity };
}

const THINKING_BLOCKS = new Set(["thinking", "redacted_thinking"]);

/**
 * Adapt the client's request to the fallback model. The model itself is chosen by the caller's
 * routing string, and chatCore already normalizes `thinking` and effort against the model
 * actually dispatched.
 *
 * Thinking blocks carry a signature issued for the model that produced them. Claude Code itself
 * drops another model's thinking blocks when a conversation continues on a new model (observed on
 * the 2.1.328 CLI, 2026-11-19), and upstream accepts a tool loop whose assistant turn has no
 * thinking block; the fallback does the same. Text, tool_use and tool_result are kept unchanged.
 */
export function adaptRequestForFallbackModel(body: JsonRecord, to: string): JsonRecord {
  const next: JsonRecord = { ...body };
  const maxOutput = getModelSpec(to)?.maxOutputTokens;
  if (typeof maxOutput === "number" && typeof next.max_tokens === "number") {
    next.max_tokens = Math.min(next.max_tokens, maxOutput);
  }
  if (Array.isArray(body.messages)) {
    let dropped = false;
    const kept = body.messages.flatMap((message) => {
      const record = asRecord(message);
      if (record?.role !== "assistant" || !Array.isArray(record.content)) return [message];
      const content = record.content.filter(
        (block) => !THINKING_BLOCKS.has(String(asRecord(block)?.type))
      );
      if (content.length === record.content.length) return [message];
      if (content.length > 0) return [{ ...record, content }];
      dropped = true;
      return [];
    });
    next.messages = dropped ? mergeAdjacentTurns(kept) : kept;
  }
  return next;
}

function asBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
}

/** An assistant turn made only of thinking leaves two turns of one role next to each other. */
function mergeAdjacentTurns(messages: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    const previous = asRecord(merged[merged.length - 1]);
    if (record && previous && record.role === previous.role) {
      merged[merged.length - 1] = {
        ...previous,
        content: [...asBlocks(previous.content), ...asBlocks(record.content)],
      };
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
    return copy;
  }
}

/** Epoch milliseconds at which the pool said this model becomes eligible again. */
function retryAt(continuity: JsonRecord): number | null {
  // `pool_eligible_at` is the first account free of all its limits; `retry_after_at` is the
  // earliest cooldown of any kind and only stands in when the pool could not date its limits.
  for (const field of ["pool_eligible_at", "retry_after_at"]) {
    const value = continuity[field];
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** Re-issue the original pool answer with the fallback outcome and the earliest honest retry. */
function poolAnswer(
  original: Response,
  first: PoolRateLimit,
  modelFallback: JsonRecord,
  limited: PoolRateLimit[]
): Response {
  const earliest = limited
    .map((entry) => retryAt(entry.continuity))
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)[0];
  void original.body?.cancel().catch(() => {});
  const continuity: JsonRecord = { ...first.continuity, model_fallback: modelFallback };
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  if (earliest !== undefined) {
    const seconds = Math.max(Math.ceil((earliest - Date.now()) / 1000), 1);
    continuity.retry_after = seconds;
    continuity.retry_after_at = new Date(earliest).toISOString();
    headers.set("Retry-After", String(seconds));
  }
  return new Response(JSON.stringify({ ...first.body, continuity }), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

/**
 * Serve a pool-wide 429 with the next model of the configured chain.
 * Returns the client's original response whenever the fallback does not apply.
 */
export async function withClaudeModelFallback(
  response: Response,
  context: {
    /**
     * The request fixed one connection, must not leave its routing constraints, or its key is
     * not bound to an explicit account pool: the original answer stands.
     */
    pinned: boolean;
    isModelAllowed: (modelStr: string) => Promise<boolean>;
    dispatch: (modelStr: string, modelFallback: ClaudeModelFallback) => Promise<Response>;
    chain?: Map<string, string>;
    terminal?: boolean;
    signal?: AbortSignal;
  }
): Promise<Response> {
  if (process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY !== "true" || context.pinned) {
    return response;
  }
  const firstLimited = await readPoolRateLimit(response);
  const originalProof = context.terminal ? terminalPools.get(response) : undefined;
  const first = firstLimited ?? (originalProof ? await readPoolAnswer(response) : null);
  if (!first) return response;

  const chain =
    context.chain ??
    parseClaudeModelFallbackChain(process.env.OMNIROUTE_CLAUDE_MODEL_FALLBACK_CHAIN);
  const resolved = first.continuity.requested_model;
  const terminalRoute = context.terminal === true && isClaudeTerminalSource(resolved);
  let terminalReason =
    terminalRoute && originalProof?.model === resolved ? originalProof?.reason : undefined;
  const requested = String(resolved).toLowerCase();
  const limited: PoolRateLimit[] = firstLimited ? [firstLimited] : [];
  const tried: string[] = [];
  const visited = new Set([requested]);
  let current = requested;

  for (let next = chain.get(current); next && !visited.has(next); next = chain.get(current)) {
    // The explicitly enrolled path can only walk Fable → Opus. A divergent
    // operator chain is not evidence of complete Claude exhaustion.
    if (terminalRoute && (current !== FABLE || next !== OPUS)) {
      terminalReason = undefined;
      break;
    }
    if (context.signal?.aborted) return response;
    visited.add(next);
    if (!(await context.isModelAllowed(`claude/${next}`))) {
      log.warn(
        "CLAUDE_CONTINUITY",
        JSON.stringify({
          provider: "claude",
          requested_model: requested,
          model_fallback: {
            from: requested,
            to: next,
            reason: terminalReason ?? "accounts_rate_limited",
          },
          result: "fallback-not-allowed-for-key",
        })
      );
      terminalReason = undefined;
      break;
    }
    if (context.signal?.aborted) return response;
    const modelFallback: ClaudeModelFallback = {
      from: requested,
      to: next,
      reason: terminalReason ?? "accounts_rate_limited",
    };
    tried.push(next);
    log.warn(
      "CLAUDE_CONTINUITY",
      JSON.stringify({
        provider: "claude",
        requested_model: requested,
        model_fallback: modelFallback,
        result: "switching-model",
      })
    );
    const fallbackResponse = await context.dispatch(`claude/${next}`, modelFallback);
    if (fallbackResponse.ok) {
      void response.body?.cancel().catch(() => {});
      return withHeaders(fallbackResponse, {
        [EFFECTIVE_MODEL_HEADER]: next,
        [MODEL_FALLBACK_HEADER]: `${requested}>${next}; reason=${modelFallback.reason}`,
      });
    }
    const nextLimited = await readPoolRateLimit(fallbackResponse);
    const nextProof = terminalRoute ? terminalPools.get(fallbackResponse) : undefined;
    const nextTerminal = nextProof?.model === next ? nextProof.reason : undefined;
    if (!nextLimited && !nextTerminal) {
      // Any other failure of the fallback model is not the client's model's answer: the client
      // keeps the honest rate-limit answer for the model it asked for.
      await fallbackResponse.body?.cancel().catch(() => {});
      log.warn(
        "CLAUDE_CONTINUITY",
        JSON.stringify({
          provider: "claude",
          requested_model: requested,
          model_fallback: modelFallback,
          result: "fallback-failed",
          fallback_status: fallbackResponse.status,
        })
      );
      return poolAnswer(
        response,
        first,
        { ...modelFallback, tried, result: "failed", status: fallbackResponse.status },
        limited
      );
    }
    await fallbackResponse.body?.cancel().catch(() => {});
    if (nextLimited) limited.push(nextLimited);
    // Do not replace missing evidence for the original pool with evidence for
    // Opus. The legacy 429 path may try Opus without a terminal attestation.
    terminalReason = terminalReason ? nextTerminal : undefined;
    current = next;
  }

  if (
    terminalReason &&
    current === OPUS &&
    !chain.has(current) &&
    !context.signal?.aborted &&
    (await context.isModelAllowed(CLAUDE_TERMINAL_TARGET)) &&
    !context.signal?.aborted
  ) {
    const modelFallback: ClaudeModelFallback = {
      from: requested,
      to: "gpt-6.2-sol",
      provider: "codex",
      reason: terminalReason,
    };
    log.warn(
      "CLAUDE_CONTINUITY",
      JSON.stringify({ result: "switching-provider", model_fallback: modelFallback })
    );
    const fallbackResponse = await context.dispatch(CLAUDE_TERMINAL_TARGET, modelFallback);
    if (fallbackResponse.ok) {
      void response.body?.cancel().catch(() => {});
      return withHeaders(fallbackResponse, {
        [EFFECTIVE_MODEL_HEADER]: modelFallback.to,
        [MODEL_FALLBACK_HEADER]: `${requested}>${modelFallback.to}; reason=${modelFallback.reason}`,
      });
    }
    void fallbackResponse.body?.cancel().catch(() => {});
    log.warn(
      "CLAUDE_CONTINUITY",
      JSON.stringify({
        result: "terminal-fallback-failed",
        status: fallbackResponse.status,
        model_fallback: modelFallback,
      })
    );
    return poolAnswer(
      response,
      first,
      {
        ...modelFallback,
        tried: [...tried, modelFallback.to],
        result: "failed",
        status: fallbackResponse.status,
      },
      limited
    );
  }
  if (tried.length === 0) return response;
  const exhausted = {
    from: requested,
    to: tried[tried.length - 1],
    reason: terminalReason ?? "accounts_rate_limited",
    tried,
    result: "unavailable",
  };
  log.warn(
    "CLAUDE_CONTINUITY",
    JSON.stringify({ provider: "claude", requested_model: requested, model_fallback: exhausted })
  );
  return poolAnswer(response, first, exhausted, limited);
}
