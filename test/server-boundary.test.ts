import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolDefinition } from "../src/tools/types.js";
import { stubFetch } from "./support/stubs.js";

/**
 * Members of `src/server.ts`'s tools/list descriptor and call boundary that
 * `server.test.ts` leaves unpinned: the `title` and full `inputSchema` on the
 * wire, the "This server serves: <names>" enumeration in the unknown-tool
 * error, the `arguments ?? {}` default for an omitted-arguments call, and the
 * non-Error arm of `describeError`. Additive: `server.test.ts` is untouched.
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

describe("the server's tools/list and call boundary", () => {
  it("serves every registry tool's title and full inputSchema, not just its name", async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    assert.equal(tools.length, TOOLS.length);
    for (const registered of TOOLS) {
      const served = tools.find((tool) => tool.name === registered.name);
      assert.notEqual(served, undefined, `${registered.name} is served`);
      assert.equal(served?.title, registered.title, `${registered.name} title`);
      // The whole schema — closures, enums, bounds — not merely `type: "object"`.
      assert.deepEqual(served?.inputSchema, registered.inputSchema, `${registered.name} inputSchema`);
    }

    await client.close();
  });

  it("names every served tool in the unknown-tool error, in registry order", async () => {
    const client = await connect();

    const expected =
      `Unknown tool "check_intent". This server serves: ${TOOLS.map((tool) => tool.name).join(", ")}.`;

    await assert.rejects(client.callTool({ name: "check_intent", arguments: {} }), (error: Error) => {
      assert.ok(
        error.message.endsWith(expected),
        `expected the message to end with:\n${expected}\ngot:\n${error.message}`,
      );
      return true;
    });

    await client.close();
  });

  it("runs a tool called with `arguments` omitted, handing it an empty object", async () => {
    const body = { repositories: [{ full_name: "acme/app", role: "owner" }] };
    const http = stubFetch({ body: JSON.stringify(body) });

    const client = await connect({
      config: loadConfig({
        SPECGUARD_ENDPOINT: "https://sg.example.com",
        SPECGUARD_USER_API_KEY: "sgu_test",
      }),
      fetch: http.fetch,
    });

    // MCP permits omitting `arguments`; the server must not trip on `undefined`.
    const result = await client.callTool({ name: "list_repositories" });

    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, body);
    assert.equal(http.requests.length, 1);
    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories");

    await client.close();
  });

  it("reports a thrown non-Error value as an internal error carrying its string form", async () => {
    const throwsAString: ToolDefinition = {
      name: "throws_a_string",
      title: "Throws a string",
      description: "Throws a bare string rather than an Error, the shape the non-Error arm of describeError exists for.",
      inputSchema: { type: "object", additionalProperties: false },
      run: async () => {
        throw "plain string failure";
      },
    };

    const client = await connect({ tools: [throwsAString] });

    const result = await client.callTool({ name: "throws_a_string", arguments: {} });

    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text:
          "specguard-mcp hit an internal error running `throws_a_string` — this is a bug in the bridge, not in your project or configuration. plain string failure",
      },
    ]);

    await client.close();
  });
});
