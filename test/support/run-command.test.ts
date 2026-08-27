import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandError } from "../../src/errors.js";
import {
  MAX_OUTPUT_BYTES,
  outstandingRunPids,
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
 * The OTHER way a run ends with no verdict: something outside this server killed
 * the child.
 *
 * `close` hands this file two branches out of one handler — our own timeout, and
 * everything else — and only the first was pinned. Both of these survived the
 * whole suite green before these tests existed: resolving with `signal: null`,
 * and resolving a signal death as `code: 0`. Neutralising the ADJACENT timeout
 * branch in the same handler went red immediately, which is what makes that a
 * gap rather than a coincidence.
 *
 * It went unnoticed because the one test named for this behaviour
 * (`lint-intent-annotations.test.ts`, "treats a signal death as no-verdict")
 * drives a stub that invents the shape it asserts. That test is right about the
 * consumer and says nothing about the producer; nothing held `runCommand` to
 * ever emitting that shape. These tests are the other half.
 *
 * Not a hypothetical for this product. `MAX_OUTPUT_BYTES` exists because this
 * server expects linters over 20k-example suites, and an OOM kill is how a run
 * that size dies — after it has already written a complete, valid JSON document.
 * A signal reported as exit 0 therefore reaches the agent as `{"ok": true}` for
 * a gate that checked nothing, which is verbatim the failure the exit-2 branch
 * in `lint-intent-annotations.ts` exists to prevent.
 *
 * Neither signal here is SIGTERM: a Node child can install a SIGTERM handler and
 * exit 0, which would make these statements about the fixture. SIGKILL cannot be
 * handled at all. SIGHUP can be in principle, but this fixture installs no
 * handler and the assertions below are `code === null` AND the signal name — so
 * a child that ever did handle it would turn this test RED rather than let it
 * pass for the wrong reason. SIGSEGV would be the more realistic crash and was
 * tried first; it is not used because each run dumps a 56 MB core file into
 * whatever directory the child is in, which is not a cost a unit test should
 * impose on every developer and CI run.
 */
describe("runCommand — a child killed by a signal is not a run that passed", () => {
  it("resolves with the signal named and the exit code left null", async () => {
    // The write CALLBACK is load-bearing. stdout to a pipe is asynchronous, so
    // killing on the next statement would race the flush and this would become a
    // test about the fixture's timing rather than about `runCommand`.
    const result = await runCommand(
      node("process.stdout.write('{\"ok\":true}', () => process.kill(process.pid, 'SIGKILL'));"),
    );

    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGKILL");
    // The document survived the kill, and that is precisely the danger: output
    // that parses is not evidence that the run finished. `signal` is the only
    // field that still knows, so it is the only field that can stop a killed run
    // from being read as a clean one.
    assert.equal(result.stdout, '{"ok":true}');
  });

  it("never reports a signal death as a clean exit", async () => {
    const result = await runCommand(
      node("process.stdout.write('x', () => process.kill(process.pid, 'SIGHUP'));"),
    );

    // The assertion a false-clean has to get past. `lint-intent-annotations`
    // routes on `code !== 0 && code !== 1`, so a signal coerced to 0 here does
    // not degrade into a worse error message downstream — it becomes `ok: true`
    // for a linter that was killed mid-run, indistinguishable from a suite with
    // nothing wrong.
    assert.notEqual(result.code, 0);
    assert.equal(result.code, null);
    // A SECOND, different signal, so `signal` is shown to carry the one that
    // actually arrived rather than a constant that happens to match the test
    // above. `code === null` above is also what proves this signal was not
    // quietly handled and turned into an ordinary exit.
    assert.equal(result.signal, "SIGHUP");
  });

  it("stays distinguishable from the timeout route, which rejects instead", async () => {
    // Both outcomes are "no verdict" and both leave the same `close` handler, so
    // they are the pair most likely to be collapsed into one branch by a later
    // edit. They are not the same event. OUR timer firing is this server's own
    // decision, the child was cut off mid-sentence, and there is no result to
    // hand back — so it rejects. A signal from outside is a FACT about the child
    // that the caller has to be able to act on — so it resolves and names it.
    const timedOut = await rejects(
      runCommand(node("setTimeout(() => {}, 60_000)"), { timeoutMs: 100 }),
      /did not finish within 100ms and was killed, so it produced no verdict/,
    );
    assert.ok(timedOut instanceof CommandError, `expected a CommandError, got ${timedOut.name}`);

    // Same handler, same SIGKILL, generous timeout that never fires: this one
    // resolves.
    const killed = await runCommand(
      node("setTimeout(() => {}, 60_000); process.kill(process.pid, 'SIGKILL');"),
      { timeoutMs: 60_000 },
    );

    assert.equal(killed.code, null);
    assert.equal(killed.signal, "SIGKILL");
  });
});

/**
 * The half of "no verdict" that used to have no verdict AND no answer.
 *
 * Everything above settles on `close`, and `close` is not the process ending —
 * it is the process ending AND every writer of its stdout/stderr pipes letting
 * go. Those descriptors are inherited, so any grandchild is such a writer. That
 * is not an exotic arrangement: `README.md` recommends `bundle exec
 * specguard-lint`, which makes `bundle` the child and the linter a grandchild,
 * and it is the shape most Ruby projects will configure.
 *
 * The timeout test above cannot see any of this. Its fixture is a DIRECT child
 * with nothing below it, so killing the child closes the pipes and `close`
 * arrives on cue. The guard was pinned to the subject and not to the axis the
 * defect lives on: every fixture in this file was a leaf process.
 *
 * These five are the axis. Each carries an explicit per-test deadline, because
 * the regression they guard against is a promise that NEVER settles — without a
 * deadline a regression is a test run that hangs rather than one that fails, and
 * a suite that hangs reports nothing at all.
 */
describe("runCommand — always settles, even when a grandchild holds the pipes", () => {
  /**
   * A child that hands its inherited stdout/stderr to a grandchild and then
   * waits. `escapes` double-detaches the grandchild into its own session, which
   * is how a grandchild survives a kill aimed at the child's process group.
   */
  function holdsPipes(grandchildMs: number, escapes: boolean, epilogue = "setTimeout(() => {}, 60_000);"): string {
    return (
      "const g = require('node:child_process')" +
      `.spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${grandchildMs})'], ` +
      `{ stdio: ['ignore', 1, 2], detached: ${String(escapes)} });` +
      (escapes ? "g.unref();" : "") +
      epilogue
    );
  }

  it("times out a run whose real work is a grandchild, instead of hanging forever", { timeout: 6_000 }, async () => {
    // The README's topology. On the old code `child.kill` signalled only the
    // direct child; the grandchild kept the write end of both pipes open, so
    // `close` never fired, `finish` never ran, and this promise never settled —
    // the timeout's own CommandError was constructed by nobody. The tool call
    // did not fail. It never returned.
    const error = await rejects(
      runCommand(node(holdsPipes(60_000, false)), { timeoutMs: 300 }),
      /did not finish within 300ms and was killed, so it produced no verdict/,
    );

    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("still settles when the grandchild escapes the process group entirely", { timeout: 6_000 }, async () => {
    // Killing the group is the first half of the fix and it is not sufficient
    // on its own: a grandchild that calls setsid (here, `detached`) is in no
    // group we can name, and it goes on holding the pipes after the child is
    // dead. `exit` — which needs nothing but the process — is what settles this
    // one, a bounded grace later. A leaked descriptor costs a truncated tail
    // instead of the caller's whole session.
    //
    // The grandchild outlives this test's own deadline ON PURPOSE. Give it a
    // lifetime shorter than the deadline and the OLD code passes this test —
    // `close` arrives late but it arrives, and the test reports success for a
    // promise that only settled because the fixture stopped holding the pipe.
    // The hold has to outlast the deadline for the assertion to be about the
    // code under test.
    const error = await rejects(
      runCommand(node(holdsPipes(15_000, true)), { timeoutMs: 300 }),
      /did not finish within 300ms and was killed, so it produced no verdict/,
    );

    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("reports the run it did get when the tail is unreachable, and says the tail is missing", { timeout: 6_000 }, async () => {
    // No timeout here — a generous one that never fires. The child finishes and
    // its exit code and output are real; only the pipes are stuck open by an
    // escaped grandchild. That is a verdict, so it resolves with one, and
    // `outputDrained` is the field that stops "everything it wrote" from being
    // read off a stream that was never read to its end.
    //
    // The grandchild outlives the deadline here for the same reason as above.
    const result = await runCommand(
      node(holdsPipes(15_000, true, "process.stdout.write('partial', () => process.exit(7));")),
      { timeoutMs: 60_000 },
    );

    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "partial");
    assert.equal(result.outputDrained, false);
    // NOT the truncation flag. That one means "we hit MAX_OUTPUT_BYTES, ask for
    // less output", which is advice that would not help here and names a cause
    // that did not happen.
    assert.equal(result.stdoutTruncated, false);
  });

  it("never calls a finished run a timeout because the deadline landed while its pipes drained", { timeout: 6_000 }, async () => {
    // `exit` and `close` are separate events, so there is a window in which the
    // process is already gone and the result is already complete. The old timer
    // set `timedOut = true` unconditionally and threw the whole run away — exit
    // code, document and all — to report that it never finished. Here the window
    // is widened to hundreds of milliseconds by an escaped grandchild so the
    // deadline lands inside it deterministically rather than by a race, but the
    // rule under test is the one-token one: a kill that signalled nothing live
    // is not a timeout.
    //
    // The only timing this depends on is the child reaching its `exit` before
    // 300ms — a bare `node -e` that writes 11 bytes. If a loaded machine ever
    // misses that, the group kill finds a live child and this fails LOUDLY with
    // the timeout message rather than passing for the wrong reason. The other
    // two edges are relative, not absolute: the grandchild releases the pipes
    // 600ms after the child exits, comfortably inside the 1s grace, so `close`
    // wins that race by the same margin however slowly the fixture starts.
    const result = await runCommand(
      node(holdsPipes(600, true, "process.stdout.write('{\"ok\":true}', () => process.exit(0));")),
      { timeoutMs: 300 },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, '{"ok":true}');
    // The pipes did close in the end, so this is a fully drained result — the
    // grace backstop above did not have to fire.
    assert.equal(result.outputDrained, true);
  });

  it("applies that to the pipe-holder that stayed in the group — the shape the README actually produces", { timeout: 6_000 }, async () => {
    // The test above with ONE argument flipped: the grandchild no longer calls
    // setsid, so it is still in the child's process group. That is the ORDINARY
    // arrangement — `bundle exec specguard-lint` leaving a helper that outlives
    // `bundle` — and escaping the group is the exotic one. It needs its own test
    // because the case above cannot see this axis at all, and the reason is
    // worth stating precisely, since the two look like the same scenario.
    //
    // Up there the group is EMPTY by the time the deadline lands: the escaped
    // grandchild took itself out of it and the child has exited. So the group
    // kill raises ESRCH, reports "nothing was signalled", and the run resolves —
    // for a reason that has nothing to do with whether it had finished. The
    // fixture's `detached: true` is what makes it green, not the rule.
    //
    // Here the group kill would SUCCEED, because the grandchild is in it and
    // very much alive. A `timedOut` read off the kill's answer therefore says
    // this completed run never finished, and throws away a real `code: 0` and a
    // whole document to say so. Only the child's own `exit` can contradict that,
    // which is the thing under test.
    const result = await runCommand(
      node(holdsPipes(600, false, "process.stdout.write('{\"ok\":true}', () => process.exit(0));")),
      { timeoutMs: 300 },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, '{"ok":true}');
    assert.equal(result.outputDrained, true);
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

/**
 * The registry the teardown handler drains.
 *
 * `killOutstandingRuns` (see `src/support/teardown.ts` and the teardown suite)
 * can only kill what this set knows about, and it kills by RAW NEGATED PID —
 * `process.kill(-pid)`, which has no liveness check of its own. So the set has
 * two obligations that are invisible from the teardown test alone, and both are
 * asserted here:
 *
 *   - it must not LEAK. A server that gained an entry per lint run would grow a
 *     list of dead pids for its whole life, and hand the next drain a fistful of
 *     numbers that no longer mean anything.
 *   - membership must mean NOT YET REAPED. `killRun` documents this as a
 *     precondition rather than a nicety: after the reap the pid is free, and on
 *     the path where the group is also empty a recycled pid leading some
 *     unrelated group would take a SIGKILL meant for a linter.
 *
 * Both are checkable only from outside, which is what `outstandingRunPids`
 * exists for.
 */
describe("runCommand — the registry teardown drains", () => {
  /**
   * A child that hands its inherited stdout/stderr to a grandchild in its OWN
   * session, and then exits.
   *
   * The same shape as `holdsPipes(..., escapes: true)` above, restated here
   * because that one is scoped to its own suite. The escape is what matters: it
   * keeps the pipes open after the child is reaped, which is what holds `exit`
   * and the settle apart long enough to tell which of the two the registry is
   * keyed to.
   */
  function escapingPipeHolder(grandchildMs: number, epilogue: string): string {
    return (
      "const g = require('node:child_process')" +
      `.spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${grandchildMs})'], ` +
      "{ stdio: ['ignore', 1, 2], detached: true });" +
      "g.unref();" +
      epilogue
    );
  }

  it("is empty once a run has settled, and stays empty across successive runs", { timeout: 6_000 }, async () => {
    // Asserted across SUCCESSIVE calls rather than one, because the failure this
    // guards is cumulative: a deregistration that never happened looks identical
    // to a correct one after a single run, and only shows up as a set that grows.
    const before = outstandingRunPids().length;

    for (let i = 0; i < 3; i++) {
      const result = await runCommand(node("process.stdout.write('ok'); process.exit(0)"));

      assert.equal(result.code, 0);
      assert.equal(
        outstandingRunPids().length,
        before,
        `run ${i + 1} left an entry behind — the registry grew to ${outstandingRunPids().length}`,
      );
    }
  });

  it("keeps nothing for a spawn that never produced a process", { timeout: 6_000 }, async () => {
    // The `error` path. There is no process here and `child.pid` is undefined, so
    // this entry could never be a legitimate kill target — but `exit` does not
    // follow `error`, so the deregistration that covers every other run does not
    // cover this one. Left in, it would sit in the set for the life of the
    // server as an entry the drain can only skip.
    const before = outstandingRunPids().length;

    await rejects(
      runCommand(["specguard-lint-does-not-exist-9f3a"]),
      /is not on this server's PATH/,
    );

    assert.equal(outstandingRunPids().length, before);
  });

  it("drops the entry when the child is REAPED, not when the promise settles", { timeout: 6_000 }, async () => {
    // The distinction the whole registry turns on, and the one a test written
    // against the settle would miss.
    //
    // These are not the same instant. An escaped grandchild holds the pipes open,
    // so `close` never comes and the run settles on the grace backstop — up to
    // EXIT_CLOSE_GRACE_MS AFTER the child's own `exit`. Deregistering at settle
    // would therefore leave a window, a whole second wide, in which the child is
    // already reaped and its pid already free while the registry still offers it
    // to the drain as a kill target. That is precisely the "SIGKILL aimed at a
    // stranger" hazard `killRun` refuses to pay.
    //
    // So: watch the registry WHILE the promise is still pending. The child exits
    // almost immediately; the promise cannot settle for ~1s after that. If the
    // entry is gone before the await returns, deregistration is keyed to the reap.
    //
    // The grandchild outlives this test's deadline on purpose, per the convention
    // above — it is what holds the pipes open and keeps the two instants apart.
    const before = outstandingRunPids().length;

    const pending = runCommand(
      node(escapingPipeHolder(15_000, "process.stdout.write('partial', () => process.exit(3));")),
      { timeoutMs: 60_000 },
    );

    // Poll for the registry to drain while the promise is demonstrably unsettled.
    let settled = false;
    void pending.then(() => (settled = true));

    let emptiedWhilePending = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (outstandingRunPids().length === before && !settled) {
        emptiedWhilePending = true;
        break;
      }
      if (settled) break;
    }

    assert.ok(
      emptiedWhilePending,
      "the entry was still registered when the promise settled — deregistration is keyed to the settle, " +
        "so a drain landing in the grace window would signal an already-reaped pid",
    );

    const result = await pending;
    assert.equal(result.code, 3);
    assert.equal(outstandingRunPids().length, before);
  });
});
