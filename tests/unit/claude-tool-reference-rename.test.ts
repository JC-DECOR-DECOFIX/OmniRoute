/**
 * Tool-search `tool_reference` blocks must follow every request-side tool rename.
 *
 * Claude Code loads deferred tools through ToolSearch: the tool_result carries
 * `{ type: "tool_reference", tool_name }` blocks that Anthropic resolves against
 * `tools[]`. The native Claude OAuth path renames tools in `tools[]`, `tool_use`
 * and `tool_choice` (proxy_ prefix strip, Claude Code casing, third-party cloak).
 * A reference left on the original name no longer matches its renamed tool, and
 * Anthropic answers `400 Tool reference '<name>' not found in available tools`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloakThirdPartyToolNames,
  remapToolNamesInRequest,
} from "../../open-sse/services/claudeCodeToolRemapper.ts";
import { stripProxyToolPrefix } from "../../open-sse/executors/claudeIdentity.ts";

type AnyRecord = Record<string, unknown>;

/** Every tool_reference name in the body, in document order. */
function referencedNames(body: AnyRecord): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const node = value as AnyRecord;
    if (node.type === "tool_reference") names.push(node.tool_name as string);
    for (const [key, child] of Object.entries(node)) if (key !== "input") visit(child);
  };
  visit(body.messages);
  return names;
}

function declaredNames(body: AnyRecord): string[] {
  return (body.tools as AnyRecord[]).map((tool) => tool.name as string);
}

/** The shape Happy's embedded Claude Code sends after a ToolSearch call. */
function clientToolSearchBody(...names: string[]): AnyRecord {
  return {
    tools: [
      { name: "ToolSearch", input_schema: { type: "object" } },
      ...names.map((name) => ({ name, defer_loading: true, input_schema: { type: "object" } })),
    ],
    messages: [
      { role: "user", content: "load the tools" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "ToolSearch", input: { query: "select" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: names.map((tool_name) => ({ type: "tool_reference", tool_name })),
          },
        ],
      },
    ],
  };
}

describe("tool_reference follows the third-party cloak", () => {
  it("renames a client ToolSearch reference with its tool (Happy create_agent)", () => {
    const body = clientToolSearchBody("create_agent", "send_agent_message");
    cloakThirdPartyToolNames(body);
    assert.deepEqual(declaredNames(body), ["ToolSearch", "CreateAgent", "SendAgentMessage"]);
    assert.deepEqual(referencedNames(body), ["CreateAgent", "SendAgentMessage"]);
    for (const name of referencedNames(body)) assert.ok(declaredNames(body).includes(name));
  });

  it("keeps the reverse map so responses restore the caller's name", () => {
    const body = clientToolSearchBody("create_agent");
    const map = cloakThirdPartyToolNames(body);
    assert.equal(map.get("CreateAgent"), "create_agent");
  });

  it("renames references inside a server tool_search_tool_result", () => {
    const body: AnyRecord = {
      tools: [{ name: "read_agent_history", defer_loading: true }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: "read_agent_history" }],
              },
            },
          ],
        },
      ],
    };
    cloakThirdPartyToolNames(body);
    assert.deepEqual(referencedNames(body), ["ReadAgentHistory"]);
  });

  it("does not mutate the caller's blocks", () => {
    const body = clientToolSearchBody("create_agent");
    const original = JSON.parse(JSON.stringify(body.messages));
    const messagesBefore = body.messages;
    cloakThirdPartyToolNames(body);
    assert.deepEqual(messagesBefore, original);
  });

  it("leaves Claude Code and MCP names untouched", () => {
    const body = clientToolSearchBody("CronCreate", "mcp__github__create_issue");
    cloakThirdPartyToolNames(body);
    assert.deepEqual(referencedNames(body), ["CronCreate", "mcp__github__create_issue"]);
  });

  it("never rewrites a tool_use input that merely looks like a reference", () => {
    const body: AnyRecord = {
      tools: [{ name: "create_agent" }],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "create_agent",
              input: { type: "tool_reference", tool_name: "create_agent" },
            },
          ],
        },
      ],
    };
    cloakThirdPartyToolNames(body);
    const block = ((body.messages as AnyRecord[])[0].content as AnyRecord[])[0];
    assert.equal(block.name, "CreateAgent");
    assert.deepEqual(block.input, { type: "tool_reference", tool_name: "create_agent" });
  });
});

describe("tool_reference never owns the reverse map", () => {
  it("a stale history reference cannot overwrite the declared tool's mapping", () => {
    // tools[] declares `applypatch`; an old reference names `apply_patch`. Both map to
    // ApplyPatch, and the response must restore the name the client declares now.
    const body = clientToolSearchBody("applypatch");
    const result = (body.messages as AnyRecord[])[2].content as AnyRecord[];
    (result[0].content as AnyRecord[]).push({ type: "tool_reference", tool_name: "apply_patch" });
    remapToolNamesInRequest(body);
    const map = body._toolNameMap as Map<string, string>;
    assert.equal(map.get("ApplyPatch"), "applypatch");
    assert.deepEqual(referencedNames(body), ["ApplyPatch", "apply_patch"]);
  });

  it("the cloak does not mint an alias for a reference to an undeclared tool", () => {
    const body = clientToolSearchBody("create_agent");
    const result = (body.messages as AnyRecord[])[2].content as AnyRecord[];
    (result[0].content as AnyRecord[]).push({ type: "tool_reference", tool_name: "gone_tool" });
    const map = cloakThirdPartyToolNames(body);
    assert.deepEqual(referencedNames(body), ["CreateAgent", "gone_tool"]);
    assert.deepEqual([...map.keys()], ["CreateAgent"]);
  });

  it("a reference takes the declared alias even when a history tool_use collides", () => {
    // search_files and grep_search both want Grep; tools[] gets Grep, the history-only
    // grep_search gets Grep2. The reference to search_files must stay on Grep.
    const body = clientToolSearchBody("search_files");
    (body.messages as AnyRecord[]).push({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_9", name: "grep_search", input: {} }],
    });
    cloakThirdPartyToolNames(body);
    assert.deepEqual(declaredNames(body), ["ToolSearch", "Grep"]);
    assert.deepEqual(referencedNames(body), ["Grep"]);
  });
});

describe("tool_reference walk is bounded to the documented shapes", () => {
  it("ignores deeply nested arrays instead of recursing into them", () => {
    let nested: unknown = [{ type: "tool_reference", tool_name: "create_agent" }];
    for (let i = 0; i < 100_000; i++) nested = [nested];
    const block = { type: "tool_result", tool_use_id: "toolu_1", content: [nested] };
    const body: AnyRecord = {
      tools: [{ name: "create_agent" }],
      messages: [{ role: "user", content: [block] }],
    };
    assert.doesNotThrow(() => cloakThirdPartyToolNames(body));
    assert.equal(((body.messages as AnyRecord[])[0].content as AnyRecord[])[0], block);
  });

  it("leaves text, image and document blocks as the same objects", () => {
    const text = { type: "text", text: "create_agent" };
    const image = { type: "image", source: { type: "base64", data: "AA==" } };
    const doc = { type: "document", source: { type: "text", data: "tool_reference" } };
    const body: AnyRecord = {
      tools: [{ name: "create_agent" }],
      messages: [{ role: "user", content: [text, image, doc] }],
    };
    const messageBefore = (body.messages as AnyRecord[])[0];
    cloakThirdPartyToolNames(body);
    assert.equal((body.messages as AnyRecord[])[0], messageBefore);
    assert.deepEqual(messageBefore.content, [text, image, doc]);
  });
});

describe("tool_reference follows the CLIProxyAPI mcp_ rewrite", () => {
  it("renames a reference to an mcp_ tool with its Mcp_ definition", async () => {
    const { CliproxyapiExecutor } = await import("../../open-sse/executors/cliproxyapi.ts");
    const executor = new CliproxyapiExecutor("http://127.0.0.1:1");
    const body = clientToolSearchBody("mcp_call", "create_agent");
    body.system = [{ type: "text", text: "test" }];
    const out = executor.transformRequest("claude-opus-5-5", body, false, null) as AnyRecord;
    assert.deepEqual(declaredNames(out), ["ToolSearch", "Mcp_call", "CreateAgent"]);
    assert.deepEqual(referencedNames(out), ["Mcp_call", "CreateAgent"]);
    assert.deepEqual(referencedNames(body), ["mcp_call", "create_agent"]);
  });
});

describe("tool_reference follows the other native renames", () => {
  it("Claude Code casing (webfetch -> WebFetch)", () => {
    const body = clientToolSearchBody("webfetch");
    remapToolNamesInRequest(body);
    assert.deepEqual(declaredNames(body), ["ToolSearch", "WebFetch"]);
    assert.deepEqual(referencedNames(body), ["WebFetch"]);
  });

  it("proxy_ prefix strip", () => {
    const body = clientToolSearchBody("proxy_lookup");
    stripProxyToolPrefix(body);
    assert.deepEqual(declaredNames(body), ["ToolSearch", "lookup"]);
    assert.deepEqual(referencedNames(body), ["lookup"]);
  });

  it("the full native chain leaves every reference resolvable", () => {
    const body = clientToolSearchBody("proxy_create_agent", "webfetch", "archive_agent");
    stripProxyToolPrefix(body);
    remapToolNamesInRequest(body);
    cloakThirdPartyToolNames(body);
    const declared = declaredNames(body);
    assert.deepEqual(referencedNames(body), ["CreateAgent", "WebFetch", "ArchiveAgent"]);
    for (const name of referencedNames(body)) assert.ok(declared.includes(name));
  });
});
