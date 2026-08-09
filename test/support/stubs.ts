import assert from "node:assert/strict";
import { loadConfig, type Config } from "../../src/config.js";
import type { CommandResult, RunCommand, RunCommandOptions } from "../../src/support/run-command.js";
import type { ToolContext } from "../../src/tools/types.js";

/** A recorded subprocess call, so a test can assert on the argv that was built. */
export interface RecordedCommand {
  readonly argv: readonly string[];
  readonly options: RunCommandOptions | undefined;
}

export interface StubCommand {
  readonly runCommand: RunCommand;
  readonly calls: RecordedCommand[];
}

/**
 * A `runCommand` that records what it was asked to run and answers with a fixed
 * result — so the linter tool is tested without an installed Ruby gem, which is
 * also what proves it is a thin client: everything under test here is argv
 * construction and exit-code interpretation, because that is all the tool does.
 */
export function stubCommand(result: Partial<CommandResult> | ((argv: readonly string[]) => Partial<CommandResult>)): StubCommand {
  const calls: RecordedCommand[] = [];

  return {
    calls,
    runCommand: async (argv, options) => {
      calls.push({ argv, options });
      const resolved = typeof result === "function" ? result(argv) : result;
      return { code: 0, signal: null, stdout: "", stderr: "", ...resolved };
    },
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface StubFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
}

/** A `fetch` that records the request and answers with a canned response. */
export function stubFetch(response: { status?: number; body?: string } = {}): StubFetch {
  const requests: RecordedRequest[] = [];

  const impl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({ url: String(input), headers });

    return new Response(response.body ?? "{}", { status: response.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: impl, requests };
}

/** A `ToolContext` with everything stubbed; each part is overridable per test. */
export function toolContext(overrides: Partial<ToolContext> & { env?: NodeJS.ProcessEnv } = {}): ToolContext {
  const config: Config = overrides.config ?? loadConfig(overrides.env ?? {});

  return {
    config,
    runCommand: overrides.runCommand ?? stubCommand({}).runCommand,
    fetch: overrides.fetch ?? stubFetch().fetch,
  };
}

/** Asserts a promise rejects with a message matching `pattern`, and returns it. */
export async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    assert.match(error.message, pattern);
    return error;
  }

  assert.fail(`expected a rejection matching ${pattern}`);
}
