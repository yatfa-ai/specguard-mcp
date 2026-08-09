import type { Config } from "../config.js";
import type { RunCommand } from "../support/run-command.js";

/**
 * The contract every tool implements — and the whole of what "the toolset grows
 * gradually" means in code.
 *
 * SPGD-310's governing constraint is that *adding a tool later must not
 * re-architect the server*. That is a statement about coupling, so it is met by
 * removing the coupling rather than by promising to be careful:
 * `src/server.ts` reads this interface and the registry array and knows nothing
 * about any individual tool — no per-tool `switch`, no name it hard-codes, no
 * branch on which capability is being wrapped. Adding a tool is therefore two
 * mechanical edits with no third:
 *
 *   1. a new file under `src/tools/` that default-exports a `ToolDefinition`;
 *   2. one entry appended to the array in `src/tools/index.ts`.
 *
 * `test/tools/registry.test.ts` asserts the properties a new entry must satisfy
 * (unique name, non-empty description, object schema) over whatever the array
 * holds, so a tool added in six months is checked by tests written today
 * without anyone remembering to extend them.
 *
 * What is deliberately NOT fixed here is the wire shape of any tool's OUTPUT.
 * The brief leaves the contract open on purpose, and each tool below returns the
 * shape of the capability it wraps — the linter's own JSON document, the API's
 * own response body — rather than a house format this server would have to
 * define, version and translate into. A thin client that reshapes its upstream
 * is not thin.
 */
export interface ToolDefinition {
  /**
   * The name the agent calls. Stable once shipped: it is the only part of a
   * tool an agent's prompt can hard-code.
   */
  readonly name: string;
  /** Short human label for clients that render one. */
  readonly title: string;
  /**
   * What the tool answers, in the terms an agent chooses by.
   *
   * This is prompt material, not documentation — it is the entire basis on
   * which a model decides whether to call the tool, so it says what question
   * the tool answers and names the limits that would otherwise be discovered
   * through a failed call.
   */
  readonly description: string;
  /**
   * A JSON Schema object — passed to the client verbatim.
   *
   * Plain JSON Schema rather than a validation library's type: it is what MCP
   * puts on the wire, so writing it directly removes a translation step and the
   * class of bug where the advertised schema and the enforced one drift.
   */
  readonly inputSchema: {
    readonly type: "object";
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
    readonly [key: string]: unknown;
  };
  /**
   * Runs the tool.
   *
   * Throws a `SpecGuardMcpError` for an expected failure — the server renders
   * it as an MCP tool error the agent can read and act on. Anything else
   * propagates as a defect.
   */
  readonly run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/**
 * Everything a tool is allowed to reach the outside world through.
 *
 * Injected rather than imported by the tools themselves, which is what makes
 * each one testable without a live SpecGuard deployment or an installed Ruby
 * gem — and what lets a tool added later be tested the same way for free.
 */
export interface ToolContext {
  readonly config: Config;
  /** Runs a subprocess. No shell is involved; see `run-command.ts`. */
  readonly runCommand: RunCommand;
  /** `fetch`, injectable so HTTP-backed tools can be tested against a stub. */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * What a tool hands back.
 *
 * `structured` is the answer as data and is what an agent should read;
 * `text` is the same answer rendered for a client that shows only text. Both
 * are derived from one value inside each tool rather than assembled twice, so
 * they cannot come to disagree about the same call.
 */
export interface ToolResult {
  readonly text: string;
  readonly structured?: Record<string, unknown>;
}
