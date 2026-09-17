import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.js";
import { SpecGuardMcpError } from "./errors.js";
import { runCommand as defaultRunCommand } from "./support/run-command.js";
import { TOOLS } from "./tools/index.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";

export const SERVER_NAME = "specguard-mcp";
export const SERVER_VERSION = readPackageVersion();

export interface CreateServerOptions {
  /** Overrides the tools served. Defaults to the registry. Tests pass their own. */
  readonly tools?: readonly ToolDefinition[];
  readonly config?: Config;
  readonly runCommand?: ToolContext["runCommand"];
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Builds the MCP server: two request handlers over the tool registry, and no
 * knowledge of any tool in particular.
 *
 * Everything a tool touches the world with — config, subprocesses, `fetch` — is
 * resolved once here and handed down as a `ToolContext`. That is what makes the
 * whole surface testable without a SpecGuard deployment or an installed gem, and
 * it is a property a tool added later inherits rather than has to arrange.
 *
 * The transport is NOT chosen here. `createServer` returns an unconnected
 * `Server`, and `bin/specguard-mcp.ts` connects it to stdio. SPGD-310 scopes
 * stdio only and puts HTTP/SSE in a later follow-up; keeping the choice out of
 * this file is what makes that follow-up a new entrypoint rather than a change
 * to the server.
 */
export function createServer(options: CreateServerOptions = {}): Server {
  const tools = options.tools ?? TOOLS;
  const context: ToolContext = {
    config: options.config ?? loadConfig(),
    runCommand: options.runCommand ?? defaultRunCommand,
    fetch: options.fetch ?? globalThis.fetch,
  };

  const byName = indexByName(tools);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(describe),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);

    // An unknown name is a protocol-level error rather than a tool result: the
    // agent did not call a tool that failed, it called something that is not a
    // tool, and reporting that as a failed call would invite a retry.
    if (tool === undefined) {
      throw new Error(
        `Unknown tool "${request.params.name}". This server serves: ` +
          `${tools.map((entry) => entry.name).join(", ")}.`,
      );
    }

    return runTool(tool, request.params.arguments ?? {}, context);
  });

  return server;
}

/**
 * One tool call, with the error boundary that keeps a bad call from becoming a
 * dead server.
 *
 * The split is between failures the agent can act on and defects it cannot.
 * A `SpecGuardMcpError` — no API key, a 401, a linter that is not installed, an
 * argument of the wrong type — comes back as `isError: true` with a sentence
 * naming the fix, which is a result the model reads and responds to. Anything
 * else is a bug in this server, and it is reported the same way rather than
 * thrown, because on stdio an unhandled rejection takes the transport down and
 * the agent sees "server exited" with no reason at all.
 */
async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<CallToolResult> {
  try {
    const result = await tool.run(args, context);

    return {
      content: [{ type: "text", text: result.text }],
      ...(result.structured === undefined ? {} : { structuredContent: result.structured }),
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: describeError(tool, error) }],
    };
  }
}

function describeError(tool: ToolDefinition, error: unknown): string {
  if (error instanceof SpecGuardMcpError) return error.message;

  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  // Named as a defect in this bridge rather than as a verdict about the user's
  // code or configuration — an agent that is told the problem is its input will
  // keep editing its input.
  return `specguard-mcp hit an internal error running \`${tool.name}\` — this is a bug in the bridge, not in your project or configuration. ${detail}`;
}

/** The registry entry as MCP puts it on the wire. */
function describe(tool: ToolDefinition): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
  };
}

/**
 * Duplicate names are caught at construction, not on first call.
 *
 * Two entries sharing a name silently shadow one another in the lookup while
 * both appear in `tools/list`, so an agent would be offered a tool that can
 * never be reached. This is the one invariant of the registry the server
 * enforces itself, because it is the one an added entry can violate by
 * accident.
 */
function indexByName(tools: readonly ToolDefinition[]): Map<string, ToolDefinition> {
  const byName = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Two tools are registered under the name "${tool.name}".`);
    }
    byName.set(tool.name, tool);
  }

  return byName;
}

/**
 * This package's version, read from the package manifest rather than kept as a
 * literal beside it.
 *
 * The literal this replaced was written at bootstrap and never revisited: the
 * release bot bumps `package.json` alone, so every initialize handshake after
 * the first release told every client the bridge was still the bootstrap
 * version. Nothing caught the drift because the constant has exactly two
 * reader cells — this file's `serverInfo` and the `src/index.ts` re-export —
 * and no test named it. `SERVER_VERSION` stays a const export with the same
 * readers; the ONLY change is that its value now tracks the release instead of
 * the bootstrap.
 *
 * `SERVER_VERSION`'s module-scope initialization is the single read: the walk
 * runs once at import, and every later reader cell sees the cached result.
 *
 * The read is a walk UP from this module to the package root, bounded and
 * name-checked — the shape specguard-ts landed for the same disease (its
 * fixed `../package.json` read resolved against the module's OWN directory and
 * answered `"0.0.0"` in every built layout). The layouts this bridge ships
 * put the compiled module at `dist/src/server.js`, `.test-build/src/server.js`
 * (the test build), or `src/server.ts` (the dev loader), and an install at
 * `node_modules/specguard-mcp/dist/src/` — in each, walking up finds the
 * manifest that names this package, where a fixed relative read would name
 * `dist/package.json` / `.test-build/package.json` (both absent; `files`
 * ships dist only, so src/ is not even present in an installed tree). The
 * name check keeps an ancestor manifest — a monorepo or a vendoring
 * application's package.json — from being mistaken for this package's, and a
 * tree with no matching manifest answers the `"0.0.0"` sentinel without
 * throwing: `createServer` must never gain a failure mode, and a version
 * that says "unknown" is honest where a crashed boot is not.
 *
 * `start` is the injection seam the tests drive the fallback and name-check
 * arms through: a filesystem path whose directory the walk begins from,
 * defaulting to this module's own file. Production always takes the default;
 * tests pass temp-tree paths so the walk can be exercised in layouts the
 * repo does not ship.
 */
export function readPackageVersion(start: string = fileURLToPath(import.meta.url)): string {
  const require = createRequire(start);
  let dir = dirname(start);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = require(join(dir, "package.json")) as
        | { name?: unknown; version?: unknown }
        | undefined;
      if (pkg !== undefined && pkg.name === "specguard-mcp" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // No manifest at this level — keep walking toward the root.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // the filesystem root
    dir = parent;
  }
  return "0.0.0";
}
