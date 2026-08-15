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
    assert.ok(
      tools.some((tool) => tool.name === "get_repository_overview"),
      "the server is still serving after a failed call",
    );

    await client.close();
  });

  it("reports a linter that is not installed as an actionable tool error", async () => {
    // Driven through the REAL `runCommand` against a binary genuinely not on
    // PATH, so the error crossing the boundary is the `CommandError` production
    // actually throws. That is the whole test. A stub throwing a raw `Error`
    // with an ENOENT code on it — which is what this example used to do — is not
    // a `SpecGuardMcpError`, so it takes describeError's FALLBACK branch and the
    // agent is told the fault is in this bridge. The example was exercising the
    // opposite of its own title, and passing.
    const client = await connect({
      config: loadConfig({ SPECGUARD_LINT_COMMAND: "specguard-lint-does-not-exist-9f3a" }),
    });

    const result = await client.callTool({ name: "lint_intent_annotations", arguments: {} });
    const text = JSON.stringify(result.content);

    assert.equal(result.isError, true);

    // The agent is told what is wrong and which variable fixes it.
    assert.match(text, /is not on this server's PATH/);
    assert.match(text, /SPECGUARD_LINT_COMMAND/);

    // The half `isError: true` cannot express. `runTool` sets that flag on BOTH
    // branches of describeError, so the old lone assertion was satisfied by
    // precisely the outcome this test exists to reject: "this is a bug in the
    // bridge, not in your project or configuration" tells the agent to stop
    // editing the only thing that is actually wrong.
    assert.doesNotMatch(text, /bug in the bridge/);

    await client.close();
  });

  it("hands a wrong-typed argument back as the caller's own fixable mistake", async () => {
    // The unit tests assert the CLASS; this asserts the consequence of the class
    // at the only boundary that reads it. `describeError` splits on
    // `instanceof SpecGuardMcpError`, so an `ArgumentError` that had been
    // declared outside that hierarchy — a plain `Error`, or a shadowing
    // `TypeError` — would take the fallback branch and tell the agent its
    // argument is a bug in this bridge. It is not: it is the one failure the
    // agent can fix from the message alone, and no config or linter was even
    // reached before it was raised.
    const client = await connect({ config: loadConfig({}) });

    const result = await client.callTool({
      name: "lint_intent_annotations",
      arguments: { changed: "yes" },
    });
    const text = JSON.stringify(result.content);

    assert.equal(result.isError, true);
    assert.match(text, /`changed` must be a boolean/);
    assert.doesNotMatch(text, /bug in the bridge/);

    const { tools } = await client.listTools();
    assert.ok(
      tools.some((tool) => tool.name === "lint_intent_annotations"),
      "the server is still serving after a bad argument",
    );

    await client.close();
  });

  it("still calls a genuine defect a bug in the bridge, and not the caller's fault", async () => {
    // The counterweight, and it is not optional. "A CommandError reaches the
    // agent verbatim" is satisfiable by a describeError that returns
    // `error.message` unconditionally — which would report every real crash in
    // this server as a verdict about the user's project, sending an agent to
    // edit code that is fine. Both directions are pinned here, or the
    // defect-vs-expected-failure split the boundary exists for is not pinned at
    // all.
    const broken: ToolDefinition = {
      name: "a_tool_with_a_defect",
      title: "A tool with a defect",
      description: "Throws the shape a real bug in this server throws: not a SpecGuardMcpError.",
      inputSchema: { type: "object", additionalProperties: false },
      run: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'ok')");
      },
    };

    const client = await connect({ tools: [broken] });

    const result = await client.callTool({ name: "a_tool_with_a_defect", arguments: {} });
    const text = JSON.stringify(result.content);

    assert.equal(result.isError, true);
    assert.match(text, /bug in the bridge, not in your project or configuration/);
    // Which tool, and what actually went wrong — a defect nobody can locate is
    // barely better than a dead pipe.
    assert.match(text, /a_tool_with_a_defect/);
    assert.match(text, /TypeError: Cannot read properties of undefined/);

    // And it is still a tool result, not a thrown rejection: on stdio an
    // unhandled one takes the transport down with every other tool on it.
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1, "the server is still serving after a defect");

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
