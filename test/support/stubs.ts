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
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputDrained: true,
        ...resolved,
      };
    },
  };
}

/**
 * A recorded HTTP call — the whole request, not just where it was sent.
 *
 * `url` and `headers` alone were enough while every tool here read; they stop
 * being enough the moment one writes. A stub that cannot observe the METHOD or
 * the BODY is structurally incapable of failing a write tool that sent a `GET`,
 * sent nothing, or nested its parameters under a key the platform does not read
 * — the assertion would be "a request was made to the right URL", which a
 * broken implementation satisfies exactly as well as a correct one.
 *
 * Recorded in `record()`, which BOTH `stubFetch` and `stubSlowFetch` share, so
 * the split-phase stub can assert on a request body too. That matters because
 * `stubSlowFetch` is the only one that can hold the two phases of a call apart,
 * and the write path has to be shown bounded across both.
 */
export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** Upper-cased, and defaulted the way `fetch` itself defaults it. */
  readonly method: string;
  /** The request body as it went on the wire, or `undefined` when there was none. */
  readonly body: string | undefined;
}

export interface StubFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
}

/** A `fetch` that records the request and answers with a canned response. */
export function stubFetch(response: { status?: number; body?: string } = {}): StubFetch {
  const requests: RecordedRequest[] = [];

  const impl = (async (input: unknown, init?: RequestInit) => {
    record(requests, input, init);

    // A null-body status (204/304) MUST be constructed without a body — the
    // `Response` constructor throws otherwise. The DELETES this bridge serves
    // answer `204` with no body at all, which is exactly what `{body: ""}`
    // means here: absent on the wire, not an empty string of JSON. Passing
    // `null` also makes `text()` resolve to `""`, so the empty-body success
    // path is tested against the same value the deployment's stream yields.
    const nullBodyStatus = [204, 205, 304].includes(response.status ?? 200);
    const wire =
      nullBodyStatus || response.body === undefined ? (nullBodyStatus ? null : "{}") : response.body;

    return new Response(wire, { status: response.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: impl, requests };
}

/**
 * A `fetch` whose HEADERS resolve at once and whose BODY arrives later — or,
 * with `"never"`, not at all.
 *
 * `stubFetch` cannot express this and no stub built on it can: `new Response(str)`
 * is already complete when it is constructed, so `text()` on it settles in the
 * same tick and the body phase is over before any deadline could apply to it.
 * The body here is a `ReadableStream`, which is what splits the two phases apart
 * — the `Response` is returned immediately, and `text()` waits on a chunk that
 * comes late or never. That is the shape of a deployment which answers `200 OK`
 * and then stops talking, and it is the only shape that can tell a client
 * bounding the whole call from one bounding only its headers.
 *
 * The enqueue timer is unref'd so a stub left mid-stream — which is the point of
 * `"never"` — cannot by itself hold the test process open.
 */
export function stubSlowFetch(
  bodyArrivesAfterMs: number | "never",
  response: { status?: number; body?: string } = {},
): StubFetch {
  const requests: RecordedRequest[] = [];

  const impl = (async (input: unknown, init?: RequestInit) => {
    record(requests, input, init);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (bodyArrivesAfterMs === "never") return;

        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(response.body ?? "{}"));
          controller.close();
        }, bodyArrivesAfterMs).unref?.();
      },
    });

    return new Response(stream, { status: response.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: impl, requests };
}

/**
 * The one place a request is captured, shared by both stubs above.
 *
 * `method` is defaulted to `GET` here rather than left `undefined`, because that
 * is what `fetch` itself does with an omitted method — a test asserting
 * `method === "GET"` should pass against a call that simply did not say, since
 * on the wire those are the same request. It is upper-cased for the same reason:
 * `fetch` normalises the verb, so a stub that reported `"post"` would make an
 * assertion fail over a difference the deployment never sees.
 *
 * `body` is narrowed to a string. Every body this bridge sends is a serialized
 * JSON string, so that is the only shape worth recording faithfully; anything
 * else (a stream, a `FormData`) is left `undefined` rather than stringified into
 * `"[object Object]"`, which would read in an assertion failure as a body that
 * was sent rather than as one this stub cannot see.
 */
function record(requests: RecordedRequest[], input: unknown, init?: RequestInit): void {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    headers[key.toLowerCase()] = value;
  }

  requests.push({
    url: String(input),
    headers,
    method: (init?.method ?? "GET").toUpperCase(),
    body: typeof init?.body === "string" ? init.body : undefined,
  });
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
