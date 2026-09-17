import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createServer, readPackageVersion, SERVER_NAME } from "../src/server.js";
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

    // Grown to three by SPGD-760, to four by SPGD-764, and to thirteen by
    // SPGD-885 (member management), to fourteen by SPGD-887 (rename), to
    // seventeen by SPGD-1039 (the agent-key family), and to eighteen by
    // SPGD-1130 (the sgk_ inventory read) —
    // grown rather than
    // loosened to a subset check on purpose: this `deepEqual` is the pin that
    // makes what the server promises an agent change only by a conscious
    // decision (`src/tools/types.ts` says so, and `src/tools/index.ts` says why
    // each of these is here). A `.includes` would let the next tool
    // advertise itself silently.
    //
    // `add_repository` is the first name on this list that WRITES, and
    // `remove_repository` the first that DESTROYS, which is the strongest
    // strongest argument the pin has ever had: the set of tools an agent may
    // discover now includes one that changes state at the deployment, so a tool
    // arriving here unnoticed is no longer merely an undocumented read.
    assert.deepEqual(names, [
      "add_repository",
      "add_repository_member",
      "create_repository_api_key",
      "get_repository_overview",
      "lint_intent_annotations",
      "list_repositories",
      "list_repository_agent_keys",
      "list_repository_agent_keys_presented_revoked",
      "list_repository_api_keys",
      "list_repository_members",
      "near_duplicate_clusters",
      "registrable_repositories",
      "remove_repository",
      "remove_repository_member",
      "rename_repository",
      "revoke_repository_agent_key",
      "revoke_repository_api_key",
      "update_repository_member_permissions",
    ]);

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

  it("calls the user-scoped tool with the OTHER key, from the same server", async () => {
    // The seam SPGD-760 opened, driven through the real protocol rather than
    // through the tool function: one server, one `loadConfig`, two credentials,
    // and the tool that reads the second one must reach the wire carrying it.
    // A unit test on the tool cannot show this — it is `createServer`'s single
    // `Config` reaching two different `require*` helpers that is under test.
    const body = { repositories: [{ full_name: "acme/app", role: "owner" }] };
    const http = stubFetch({ body: JSON.stringify(body) });

    const client = await connect({
      config: loadConfig({
        SPECGUARD_ENDPOINT: "https://sg.example.com",
        SPECGUARD_API_KEY: "sgk_test",
        SPECGUARD_USER_API_KEY: "sgu_test",
      }),
      fetch: http.fetch,
    });

    const result = await client.callTool({ name: "list_repositories", arguments: {} });

    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, body);
    // Both halves: the user endpoint, and the user key — with the repository key
    // also present in the same environment, so picking the wrong one is a
    // failure this example can see rather than a value it never had.
    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgu_test");

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
      tools.some((tool) => tool.name === "lint_intent_annotations"),
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
      description: "Stands in for a tool the server has never heard of, proving that adding one is registry-entry-only. Named in SPGD-310 while SPGD-114/SPGD-115 were open; both completed 2026-09-06 — SPGD-115's duplicate-clustering surface landed here as near_duplicate_clusters (374a6e2), and SPGD-114's file-shaped aggregation is served by specguard's API/web, not wrapped as a tool here.",
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

/**
 * The expected version, read INDEPENDENTLY of the code under test.
 *
 * Deliberately a second implementation of the walk rather than a call into
 * `readPackageVersion`: a pin that resolves its expectation through the code
 * it pins cannot fail when that code resolves the WRONG manifest — the two
 * would agree with each other all the way to a wrong version. It walks up
 * from the TEST file's own module rather than reading a fixed
 * `../package.json`, because from the compiled layout (`.test-build/test/`)
 * that fixed read names `.test-build/package.json` — absent, the exact
 * disease this suite pins against — and the expectation would silently
 * become the throw below on every `npm test` run. Failing loudly is right
 * for an expectation read: unlike the resolver, a test whose manifest
 * cannot be found has nothing honest to assert.
 */
function packageVersionFromManifest(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = require(join(dir, "package.json")) as
        | { name?: unknown; version?: unknown }
        | undefined;
      if (pkg !== undefined && pkg.name === "specguard-mcp" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // No manifest at this level — keep walking toward the repo root.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // the filesystem root
    dir = parent;
  }
  throw new Error("test could not find the specguard-mcp package manifest");
}

describe("the version the server advertises", () => {
  it("tells a connecting client its real package version in serverInfo", async () => {
    // The pin that would have caught the bootstrap constant: the initialize
    // handshake's serverInfo.version must equal the manifest the release bot
    // bumps, read here independently of the resolver under test. The old
    // bootstrap literal served every release after the first, because
    // nothing read this cell at all.
    const client = await connect();

    const serverInfo = client.getServerVersion();
    assert.equal(serverInfo?.name, SERVER_NAME);
    assert.equal(serverInfo?.version, packageVersionFromManifest());

    await client.close();
  });

  it("walks up from the injected start to a manifest that names this package", () => {
    // The seam the resolver exposes for exactly this arm: the walk begins at
    // `dirname(start)` and climbs, so a layout-shaped start (the module two
    // directories below the manifest, as dist/src/server.js and
    // .test-build/src/server.js both sit) finds it. The start file itself
    // need not exist — resolution runs off its directory.
    const root = mkdtempSync(join(tmpdir(), "sgmcp-version-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "specguard-mcp", version: "7.7.7" }),
      );
      assert.equal(readPackageVersion(join(root, "dist", "src", "server.js")), "7.7.7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a manifest that names some other package", () => {
    // The ancestor trap: a vendoring application's or monorepo's
    // package.json must never be mistaken for this package's, even when it
    // sits exactly where the walk looks first — so the answer is the
    // fallback, not the foreign version.
    const root = mkdtempSync(join(tmpdir(), "sgmcp-version-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "some-vendoring-app", version: "9.9.9" }),
      );
      assert.equal(readPackageVersion(join(root, "dist", "src", "server.js")), "0.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers 0.0.0 without throwing when no discoverable manifest names this package", () => {
    // The no-throw contract, driven at unit level through the injected start
    // rather than by booting a manifest-less process: the temp tree is deep
    // enough that the walk's own six-level bound ends it inside the tree,
    // so nothing above can answer either — the honest "unknown" sentinel and
    // no exception, which is what lets `createServer` keep its documented
    // no-I/O, no-validation construction contract.
    const root = mkdtempSync(join(tmpdir(), "sgmcp-version-"));
    try {
      const deep = join(root, "a", "b", "c", "d", "e", "f", "server.js");
      assert.equal(readPackageVersion(deep), "0.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still constructs the server — the resolver never gains a failure mode", () => {
    // The construction half of the fallback contract, asserted directly: the
    // bin's design is a server that constructs with no I/O and no
    // validation, so a resolution that threw would take every entrypoint
    // down at import. Every other test in this file constructs a server
    // through the same import; this one exists so the contract has a named
    // home beside the resolver arms it guards.
    assert.doesNotThrow(() => createServer({ tools: [] }));
  });
});
