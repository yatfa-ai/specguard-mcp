import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { ToolDefinition } from "../src/tools/types.js";
import { stubCommand, stubFetch } from "./support/stubs.js";

/**
 * The acceptance criterion, executed.
 *
 * SPGD-310's Territory section asks for one observable outcome: an
 * MCP-compatible agent configured with this server *discovers and calls
 * SpecGuard tools with zero HTTP/auth code in the prompt*. These tests are a
 * real MCP client speaking the real protocol to the real server over a linked
 * transport pair — the only substitution is the two seams that would otherwise
 * need a live deployment and an installed Ruby gem.
 */
async function connect(options: Parameters<typeof createServer>[0] = {}): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    createServer(options).connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return client;
}

describe("an MCP client against the server", () => {
  it("discovers the bootstrap tools", async () => {
    const client = await connect();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, ["get_repository_overview", "lint_intent_annotations"]);

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 0);
      assert.equal(tool.inputSchema.type, "object");
    }

    await client.close();
  });

  it("calls the lint tool and gets findings back as structured data", async () => {
    const document = {
      schema: "open-test-intent.v1.json",
      mode: "source",
      ok: false,
      summary: { files: 1, annotations: 1, failed: 1 },
      findings: [{ file: "spec/order_spec.rb", line: 9, ok: false, kind: "schema", errors: ["<root>: missing required property 'entity'"] }],
    };

    const client = await connect({
      config: loadConfig({}),
      runCommand: stubCommand({ code: 1, stdout: JSON.stringify(document) }).runCommand,
    });

    const result = await client.callTool({
      name: "lint_intent_annotations",
      arguments: { paths: ["spec/order_spec.rb"] },
    });

    // Exit 1 is findings, not a failure — the agent must be handed the finding,
    // not told the tool broke.
    assert.notEqual(result.isError, true);
    assert.deepEqual((result.structuredContent as Record<string, unknown>)["report"], document);

    await client.close();
  });

  it("calls the repository tool with no HTTP or auth code in the request", async () => {
    // The whole point of the bridge: the client sends `{}` and the server
    // supplies the endpoint, the Bearer header and the path.
    const body = { repository: { full_name: "acme/app" }, latest_run: { total_specs: 20_000 } };
    const http = stubFetch({ body: JSON.stringify(body) });

    const client = await connect({
      config: loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" }),
      fetch: http.fetch,
    });

    const result = await client.callTool({ name: "get_repository_overview", arguments: {} });

    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, body);
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");

    await client.close();
  });

  it("returns a missing API key as a readable tool error, and stays up", async () => {
    // The load-bearing half is "stays up": a server that exited on a missing key
    // would take the lint tool — which needs no key — down with it.
    const client = await connect({ config: loadConfig({}) });

    const result = await client.callTool({ name: "get_repository_overview", arguments: {} });

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /SPECGUARD_API_KEY/);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 2, "the server is still serving after a failed call");

    await client.close();
  });

  it("reports a linter that is not installed as an actionable tool error", async () => {
    const client = await connect({
      runCommand: async () => {
        throw Object.assign(new Error("spawn specguard-lint ENOENT"), { code: "ENOENT" });
      },
    });

    const result = await client.callTool({ name: "lint_intent_annotations", arguments: {} });

    assert.equal(result.isError, true);

    await client.close();
  });

  it("rejects an unknown tool name as a protocol error rather than a failed call", async () => {
    const client = await connect();

    await assert.rejects(
      client.callTool({ name: "check_intent", arguments: {} }),
      /Unknown tool/,
    );

    await client.close();
  });
});

describe("adding a tool", () => {
  it("needs only a registry entry — the server has no per-tool code", async () => {
    // This is SPGD-310's "a future tool can be added without touching the
    // bootstrap shape of the server", asserted rather than asserted-in-prose:
    // an arbitrary definition the server has never heard of is discovered and
    // called through the same two handlers, with the same injected context.
    const future: ToolDefinition = {
      name: "a_tool_added_later",
      title: "A tool added later",
      description: "Stands in for whatever SPGD-114 and SPGD-115 land, to prove the seam holds.",
      inputSchema: {
        type: "object",
        properties: { echo: { type: "string", description: "Echoed back." } },
        additionalProperties: false,
      },
      run: async (args, context) => ({
        text: `echo:${String(args["echo"])}`,
        structured: { echo: args["echo"], sawContext: context.config !== undefined },
      }),
    };

    const client = await connect({ tools: [future] });

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["a_tool_added_later"]);

    const result = await client.callTool({ name: "a_tool_added_later", arguments: { echo: "hi" } });
    assert.deepEqual(result.structuredContent, { echo: "hi", sawContext: true });

    await client.close();
  });

  it("refuses two tools registered under one name", () => {
    const duplicate: ToolDefinition = {
      name: "same_name",
      title: "t",
      description: "d",
      inputSchema: { type: "object", additionalProperties: false },
      run: async () => ({ text: "" }),
    };

    // Both would appear in tools/list while only one could ever be called.
    assert.throws(() => createServer({ tools: [duplicate, { ...duplicate }] }), /Two tools are registered/);
  });
});
