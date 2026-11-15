/**
 * Claude Code CCH (Client Content Hash) signing.
 *
 * Real Claude Code uses Bun/Zig to compute an xxHash64 integrity token over
 * the serialized request body. The server verifies this to confirm the request
 * came from a genuine Claude Code client.
 *
 * Algorithm:
 *   1. Serialize request body with cch=00000 placeholder
 *   2. xxHash64(body_bytes, seed) & 0xFFFFF
 *   3. Zero-padded 5-char lowercase hex
 *   4. Replace cch=00000 with computed value
 */

import xxhashInit from "xxhash-wasm";

const CCH_SEED = 0x6e52736ac806831en;
const CCH_PATTERN = /\bcch=([0-9a-f]{5});/;

let xxhashPromise: Promise<void> | null = null;
let xxhash64Fn: ((input: Uint8Array, seed: bigint) => bigint) | null = null;

async function ensureXxhash() {
  if (xxhash64Fn) return;
  if (!xxhashPromise) {
    xxhashPromise = (async () => {
      const hasher = await xxhashInit();
      xxhash64Fn = hasher.h64Raw;
    })();
  }
  return xxhashPromise;
}

export async function computeCCH(bodyBytes: Uint8Array): Promise<string> {
  await ensureXxhash();
  const hash = xxhash64Fn!(bodyBytes, CCH_SEED);
  const masked = hash & 0xfffffn;
  return masked.toString(16).padStart(5, "0");
}

export async function signRequestBody(bodyString: string): Promise<string> {
  if (!CCH_PATTERN.test(bodyString)) return bodyString;
  // Sign only billing, never CCH-looking literals in user text or tool results.
  // Newer native clients omit billing CCH and must keep that request shape.
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyString);
  } catch {
    return bodyString;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return bodyString;
  const blocks = Array.isArray(body.system) ? body.system : [];
  const billing = blocks.find((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const text = (block as Record<string, unknown>).text;
    return (
      typeof text === "string" &&
      text.startsWith("x-anthropic-billing-header:") &&
      CCH_PATTERN.test(text)
    );
  }) as Record<string, unknown> | undefined;
  // Retain the helper's legacy explicit billing-field form.
  const target = billing ?? body;
  const field = billing ? "text" : "x-anthropic-billing-header";
  const text = target[field];
  if (typeof text !== "string" || !CCH_PATTERN.test(text)) return bodyString;
  target[field] = text.replace(CCH_PATTERN, "cch=00000;");
  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(JSON.stringify(body));
  const token = await computeCCH(bodyBytes);
  target[field] = String(target[field]).replace(CCH_PATTERN, `cch=${token};`);
  return JSON.stringify(body);
}

export { CCH_PATTERN };
