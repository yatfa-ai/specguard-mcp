import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandError } from "../../src/errors.js";
import {
  MAX_OUTPUT_BYTES,
  runCommand,
  type CommandResult,
} from "../../src/support/run-command.js";
import { rejects } from "./stubs.js";

/**
 * These run REAL processes.
 *
 * Everything this file is responsible for is behaviour of `spawn` itself — which
 * failures arrive as an `error` event rather than an exit code, that a missing
 * `cwd` is reported with the same ENOENT as a missing binary, that an argument
 * list is not parsed as shell syntax. A stub would be a restatement of my beliefs
 * about `spawn`, and the defect these tests exist to prevent was exactly a wrong
 * belief about `spawn`. `process.execPath` is used as the program because a Node
 * binary is the one executable guaranteed to be here.
 *
 * == Why every rejection below asserts a TYPE as well as a message
 *
 * The message is only half the contract. `server.ts`'s error boundary splits on
 * `error instanceof SpecGuardMcpError`: a `CommandError` reaches the agent as
 * its own sentence, anything else is prefixed with "this is a bug in the bridge,
 * not in your project or configuration". So a throw here that carried the right
 * words in a plain `Error` would be delivered to the agent INVERTED — told the
 * fault is in this server, when the sentence it is wrapping names a missing
 * binary the operator can install. A message-only assertion cannot see that
 * happen: it reads the same either way.
 */
function node(script: string, args: readonly string[] = []): readonly string[] {
  return [process.execPath, "-e", script, ...args];
}

describe("runCommand — a verdict, or a legible reason there is none", () => {
  it("reports the exit code and streams rather than judging them", async () => {
    const result = await runCommand(
      node("process.stdout.write('out'); process.stderr.write('err'); process.exit(1)"),
    );

    // Exit 1 is the linter's "found something" and must survive as data.
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.stdoutTruncated, false);
  });

  it("never involves a shell, so a model-supplied argument cannot become syntax", async () => {
    const dangerous = "; echo pwned > /tmp/specguard-mcp-pwned";

    const result = await runCommand(node("process.stdout.write(process.argv[1])", [dangerous]));

    assert.equal(result.stdout, dangerous);
  });

  it("reports a timeout as no-verdict, not as a run that finished", async () => {
    const error = await rejects(
      runCommand(node("setTimeout(() => {}, 60_000)"), { timeoutMs: 100 }),
      /did not finish within 100ms and was killed, so it produced no verdict/,
    );

    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });
});

/**
 * The finding this file was added for.
 *
 * Node surfaces a non-existent `cwd` as ENOENT on the spawn — the same code and
 * shape as a program that is not on PATH — so a single ENOENT branch answers a
 * mistyped directory with "the command is not installed". That is not a cosmetic
 * mistake: it names the one thing that was right and sends the caller to change
 * it.
 */
describe("runCommand — ENOENT names the thing that was actually missing", () => {
  const MISSING_PROGRAM = "specguard-lint-does-not-exist-9f3a";

  it("says PATH when the program is the missing thing", async () => {
    const error = await rejects(runCommand([MISSING_PROGRAM]), /is not on this server's PATH/);

    assert.doesNotMatch(error.message, /working directory/);
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("appends the caller's hint on that path, and only there", async () => {
    await rejects(
      runCommand([MISSING_PROGRAM], { notFoundHint: "Set SPECGUARD_LINT_COMMAND." }),
      /is not on this server's PATH\. Set SPECGUARD_LINT_COMMAND\./,
    );

    // The hint belongs to the missing-binary diagnosis. A bad cwd must not
    // inherit it, because it would be advice about the wrong problem.
    const badCwd = await rejects(
      runCommand(node(""), { cwd: "/definitely/not/here", notFoundHint: "Set SPECGUARD_LINT_COMMAND." }),
      /working directory "\/definitely\/not\/here" does not exist/,
    );

    assert.doesNotMatch(badCwd.message, /SPECGUARD_LINT_COMMAND/);
  });

  it("says working directory when the cwd is the missing thing — with a program that IS on PATH", async () => {
    const error = await rejects(
      runCommand(node("process.exit(0)"), { cwd: "/definitely/not/here" }),
      /working directory "\/definitely\/not\/here" does not exist/,
    );

    assert.doesNotMatch(error.message, /is not on this server's PATH/);
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("treats a file given as a cwd the same way, though the code is ENOTDIR not ENOENT", async () => {
    // Found by running it, and it changed the design. `spawn` reports a
    // file-as-cwd with ENOTDIR and throws it SYNCHRONOUSLY rather than emitting
    // an `error` event, so a handler keyed on ENOENT in the event listener never
    // saw it: the raw `Error: spawn ENOTDIR` escaped this file entirely and would
    // have reached the agent as "a bug in the bridge". Hence the cwd is now
    // checked before spawning at all, and the spawn call itself is wrapped.
    const error = await rejects(
      runCommand(node("process.exit(0)"), { cwd: process.execPath }),
      /does not exist, or is not a directory/,
    );

    assert.match(error.message, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(error.message, /is not on this server's PATH/);
    // The type matters most on exactly this path: the raw `Error: spawn ENOTDIR`
    // that used to escape here is the shape the boundary calls a bridge defect.
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("refuses an empty argv instead of spawning nothing", async () => {
    // Thrown synchronously, before any promise exists — there is nothing to await.
    assert.throws(
      () => runCommand([]),
      (error: unknown) => {
        assert.ok(error instanceof CommandError, `expected a CommandError, got ${String(error)}`);
        assert.match(error.message, /No command was configured to run/);
        return true;
      },
    );
  });
});

describe("runCommand — bounded output", () => {
  it("flags truncation instead of leaving it to be inferred from the text", async () => {
    // Above the ceiling by a megabyte, written in chunks so this is a real
    // multi-`data`-event stream rather than one giant write.
    const result: CommandResult = await runCommand(
      node(
        "const mb = 'x'.repeat(1024 * 1024);" +
          "for (let i = 0; i < 5; i++) process.stdout.write(mb);",
      ),
    );

    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, false);
    // The marker stays in the text too: a JSON document cut in half must not
    // parse as a document that ended.
    assert.match(result.stdout, /\[truncated at \d+ bytes\]$/);
    assert.ok(
      result.stdout.length <= MAX_OUTPUT_BYTES + 64,
      `expected the buffer to stop near ${MAX_OUTPUT_BYTES} bytes, got ${result.stdout.length}`,
    );
  });
});
