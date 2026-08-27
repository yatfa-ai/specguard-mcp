import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { CommandError } from "../errors.js";

export interface CommandResult {
  /** The process's exit code, or `null` when a signal killed it. */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Whether the stream hit `MAX_OUTPUT_BYTES` and lost its tail.
   *
   * Reported rather than left to be inferred from the marker in the text: a
   * caller that parses the output needs to know the difference between "this
   * program emits garbage" and "we cut its output in half", and only this file
   * knows which happened.
   */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /**
   * Whether the streams were read to their end before this result was produced.
   *
   * Normally true: the result is built when the pipes close, so everything the
   * command wrote is here. It is false only on the backstop path below — the
   * process has exited but something still holds its pipe open, so we answer
   * with what was buffered rather than never answering at all.
   *
   * A SEPARATE field from `stdoutTruncated` rather than a second way to set it,
   * because the two have different causes and different remedies, and the caller
   * acts on the difference: `stdoutTruncated` means the output exceeded
   * `MAX_OUTPUT_BYTES` and the fix is to ask for less (see
   * `lint-intent-annotations.ts`'s "narrow the run with `paths`"), which would
   * be advice about the wrong problem here. This tail was lost to a leaked file
   * descriptor and asking for less output would not change it.
   *
   * Where that difference is acted on, so this stays checkable rather than
   * merely asserted: `parseReport` in `lint-intent-annotations.ts` consults this
   * on both of its failure branches — `undrainedPipe` there names the
   * pipe-holder instead of blaming the linter or `SPECGUARD_LINT_COMMAND`, and
   * is ordered after the truncation branch for the run that manages both. Note
   * it is consulted only where something is already missing: false here does NOT
   * mean the result is incomplete, only that the tail was not waited for, so a
   * run whose last undrained byte was a newline is an ordinary success.
   */
  readonly outputDrained: boolean;
}

export interface RunCommandOptions {
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Extra guidance appended when the program is not on PATH.
   *
   * Supplied by the caller because only the caller knows which env var
   * configures ITS command. A generic helper that hard-codes one tool's variable
   * name starts lying the moment a second tool spawns something else.
   */
  readonly notFoundHint?: string | undefined;
}

export type RunCommand = (
  argv: readonly string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

/** Beyond this, a wrapped command's output is truncated rather than buffered. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Default ceiling on how long a wrapped command may run. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * How long `close` may lag `exit` before the result is produced without it.
 *
 * `exit` and `close` are two events, not one: `close` additionally waits for
 * every writer of the child's stdout/stderr pipes to let go, and a process that
 * is not the child can be holding them. Long enough that the ordinary
 * milliseconds-apart drain is never cut short; short enough that a leaked
 * descriptor costs a truncated tail instead of a call that never returns.
 */
export const EXIT_CLOSE_GRACE_MS = 1_000;

type LiveChild = ReturnType<typeof spawnChild>;

/**
 * The runs that are spawned and not yet reaped.
 *
 * This exists because `detached: true` below buys the reach of the timeout kill
 * and PAYS for it: a detached child is in a new session, outside this server's
 * controlling terminal, so a signal aimed at OUR group — an interactive Ctrl-C,
 * a supervisor's `kill -- -PGID` — no longer reaches a lint run in flight. The
 * run is then orphaned, and orphaned WITHOUT A DEADLINE: the 120s ceiling is a
 * parent-side `setTimeout`, so killing the parent destroys the only thing that
 * was going to stop it. On a 20k-example suite that is a full lint's worth of
 * CPU held by a process attached to nothing. `killOutstandingRuns` is the
 * teardown path that closes it, and this set is what tells it whom to signal.
 *
 * MEMBERSHIP MEANS "NOT YET REAPED", and that is load-bearing rather than
 * descriptive: `killRun` signals a raw negated pid, which has no liveness check
 * of its own, so a stale entry is a SIGKILL aimed at whatever recycled that pid.
 * Entries are therefore removed on the child's own `exit` — the reap — and NOT
 * at settle, which on the grace-backstop path happens up to EXIT_CLOSE_GRACE_MS
 * later. Deleting at settle would leave exactly the window in which a drain
 * would signal a freed pid.
 *
 * The accepted consequence is the one this file already takes at `killRun`: a
 * straggler outliving an already-exited child is not killed at teardown. That
 * trade is deliberate and is not widened here.
 */
const liveChildren = new Set<LiveChild>();

/**
 * The pids of every run currently spawned and not yet reaped.
 *
 * Exported for the teardown handler's diagnostics and for the tests that assert
 * this set cannot leak — a registry that grew by one per call would be a slow
 * memory leak in a long-lived server, and it is only checkable from outside.
 */
export function outstandingRunPids(): readonly number[] {
  const pids: number[] = [];
  for (const child of liveChildren) {
    if (child.pid !== undefined) pids.push(child.pid);
  }
  return pids;
}

/**
 * Kills every run still in flight, and answers how many it signalled.
 *
 * The teardown path. SYNCHRONOUS AND UNBOUNDED BY NOTHING — it sends signals and
 * returns, it never waits for a child to die. That is deliberate: this runs from
 * a SIGINT/SIGTERM handler, where anything that waits is something that can hang
 * the shutdown it was supposed to perform. SIGKILL is not refusable, so there is
 * no acknowledgement worth waiting for.
 *
 * It reuses `killRun` rather than re-deriving the kill, so the group-vs-child
 * fallback and the spawn-failure guard have exactly one implementation. The set
 * is snapshotted before iterating because `killRun` can drive an `exit` that
 * mutates it.
 */
export function killOutstandingRuns(): number {
  const children = [...liveChildren];
  let signalled = 0;

  for (const child of children) {
    // Removed FIRST, so the entry is gone even if the kill throws. A registry
    // that kept a child it had already tried to kill would hand a second drain
    // the same stale pid.
    liveChildren.delete(child);
    if (killRun(child)) signalled += 1;
  }

  return signalled;
}

/**
 * Runs a program with an argument LIST, never through a shell.
 *
 * `spawn` without `shell: true` is the load-bearing detail: tool arguments
 * arrive from a model, so a file path containing `; rm -rf …` has to be a
 * path that does not exist rather than a command. There is no escaping to get
 * right because nothing is ever parsed as syntax.
 *
 * A non-zero exit is NOT an error here. `specguard-lint` uses its exit code as
 * a three-valued verdict — 0 clean, 1 malformed annotations, 2 the tool could
 * not do its job — so deciding what a code means is the caller's job and this
 * function reports it. What IS an error is the process never running (missing
 * binary) or never finishing (timeout): both leave the caller with no verdict
 * at all, which is the one outcome that must not be mistaken for a clean run.
 */
export const runCommand: RunCommand = (argv, options = {}) => {
  const [program, ...args] = argv;

  if (program === undefined) {
    throw new CommandError("No command was configured to run.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  return new Promise<CommandResult>((resolve, reject) => {
    // Checked before spawning, not diagnosed afterwards. `spawn` reports a
    // working directory it cannot use by TWO different routes depending on the
    // errno: an async `error` event (ENOENT, for a directory that is not there)
    // and a synchronous throw (ENOTDIR, for one that is a file). The synchronous
    // one is not a `CommandError`, so it would escape this whole file and be
    // reported to the agent as a bug in the bridge. Asking first collapses both
    // into one sentence that names the directory.
    if (options.cwd !== undefined && !isDirectory(options.cwd)) {
      reject(new CommandError(unusableCwd(program, options.cwd)));
      return;
    }

    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(program, args, options);
    } catch (error) {
      // Belt and braces for the synchronous route: whatever `spawn` decides to
      // throw, the agent gets a sentence about a command, never a raw errno that
      // the error boundary would classify as a defect in this server.
      reject(new CommandError(describeSpawnFailure(program, error as NodeJS.ErrnoException, options)));
      return;
    }

    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    let settled = false;
    let timedOut = false;
    let exited = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      // Whether the RUN is still live — asked of the process, not of the kill.
      // `exit` and `close` are separate events, so there is a window in which
      // the process is already gone and a complete result is already on its way.
      // A deadline landing in there has nothing to time out, and claiming one
      // would throw the finished run away, exit code and document and all, to
      // report that it never finished.
      //
      // `killRun`'s answer cannot be that test on its own, which is the trap
      // this guard exists for. It reports whether anything in the process GROUP
      // was signalled, and the group outlives the child by exactly the
      // grandchild holding the pipes open — the same grandchild that made the
      // window wide enough for a deadline to land in it at all. So on the
      // topology this file is about, the kill SUCCEEDS after the child is gone,
      // and a `timedOut` read off that answer calls a completed `code: 0` run a
      // timeout. Only the child's own exit can contradict it.
      //
      // Returning rather than killing and discarding the answer: once the child
      // has been reaped its pid is no longer ours to signal — see `killRun`.
      if (exited) return;

      timedOut = killRun(child);
    }, timeoutMs);
    // `unref` so a hung command's timer cannot by itself hold the process open.
    timer.unref?.();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      fn();
    };

    /**
     * The one place a result is produced, reached from `close` and from the
     * grace backstop alike — so the two cannot drift into disagreeing about
     * what a timeout is. `timedOut` still decides reject-vs-resolve on BOTH:
     * our own deadline is this server's decision and has no verdict to hand
     * back, while a signal from outside is a fact about the child the caller
     * has to be able to act on.
     */
    const settleWith = (code: number | null, signal: NodeJS.Signals | null, drained: boolean) => {
      finish(() => {
        if (timedOut) {
          reject(
            new CommandError(
              `\`${program}\` did not finish within ${timeoutMs}ms and was killed, ` +
                "so it produced no verdict.",
            ),
          );
          return;
        }

        resolve({
          code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputDrained: drained,
        });
      });
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      // The spawn-failure path: there is no process, and `child.pid` is
      // `undefined`, so this entry can never be a legitimate kill target. Dropped
      // here because `exit` does not always follow an `error` — leaving it would
      // strand an unkillable entry in the registry for the life of the server.
      liveChildren.delete(child);

      finish(() => reject(new CommandError(describeSpawnFailure(program, error, options))));
    });

    /**
     * The backstop, and the reason this promise no longer depends on `close`.
     *
     * `close` fires only once the process has ended AND every writer of its
     * stdout/stderr pipes has let go. Those descriptors are inherited, so a
     * grandchild holds them: `bundle exec specguard-lint` — the configuration
     * this project's README recommends — makes `bundle` the child and the linter
     * a grandchild, and killing the group can still miss a great-grandchild that
     * escaped it by double-forking. When that happens `close` never arrives, and
     * with it as the only settle the promise never settles: in an MCP server
     * that is a tool call that never returns, and therefore a calling agent that
     * never returns.
     *
     * So `exit` — which needs nothing but the process — starts a short clock.
     * The normal drain finishes in milliseconds and `close` wins the race; only
     * a genuinely leaked descriptor reaches the timer, and it pays a truncated
     * tail rather than the whole session.
     */
    child.on("exit", (code, signal) => {
      // Recorded before anything else, and read by the deadline above: from here
      // on we hold a real `code`/`signal`, so whatever the timer may still find
      // alive in the process group, this is not a run that produced no verdict.
      exited = true;

      // Deregistered HERE — at the reap, alongside `exited`, and deliberately not
      // at the settle below. The two are not the same instant: on the grace
      // backstop `exit` fires and `settleWith` follows up to EXIT_CLOSE_GRACE_MS
      // later, so a registry keyed on settle would hold a child whose pid the
      // kernel has already freed, and a teardown drain landing in that window
      // would fire `process.kill(-pid)` at whatever now owns that number. That
      // is the unrecoverable, aimed-at-a-stranger hazard `killRun` documents and
      // refuses to pay; membership must mean "not yet reaped" so its precondition
      // holds by construction.
      //
      // Placed BEFORE the `settled` early-return for the same reason: the
      // already-settled path is a reap too, and returning first would leak the
      // entry.
      liveChildren.delete(child);

      if (settled) return;

      graceTimer = setTimeout(() => {
        // Released here rather than left to the garbage collector: the pipe is
        // still open by definition on this path, so the two buffers behind it
        // (up to MAX_OUTPUT_BYTES each) would be retained for the life of
        // whatever is holding the descriptor.
        child.stdout.destroy();
        child.stderr.destroy();
        settleWith(code, signal, false);
      }, EXIT_CLOSE_GRACE_MS);
      // Deliberately NOT `unref`'d, unlike the deadline above. That one is a
      // ceiling on someone else's work and must never be the reason this process
      // stays up; this one IS the settle — an unref'd timer only fires while
      // something else holds the loop open, and the thing holding it here is the
      // very pipe we are giving up on. It is bounded at EXIT_CLOSE_GRACE_MS and
      // cleared by `finish`, so the most it can cost is one second of shutdown.
    });

    child.on("close", (code, signal) => settleWith(code, signal, true));
  });
};

/**
 * Kills the whole run, and answers whether there was anything to kill.
 *
 * `child.kill()` signals the CHILD. With `bundle exec specguard-lint` the child
 * is `bundle` and the thing doing the work is its grandchild, which survives —
 * still running, and still holding the pipes that `close` waits on. `detached`
 * in `spawnChild` makes the child a process-group leader precisely so this
 * function can signal the negated pid and reach the whole tree.
 *
 * The return value is the answer to "was a live process signalled", which is
 * half of what the caller needs to decide whether a timeout actually happened —
 * the other half is whether the CHILD has exited, because this group can outlive
 * it. ESRCH — the group is already gone — is the normal way to learn "no", so it
 * falls back to `child.kill`, whose `false` says the same thing about the child
 * alone and whose own liveness check is what makes this safe on a platform where
 * the group kill is not available.
 *
 * ONLY CALLED WHILE THE CHILD IS STILL LIVE, and that is a precondition rather
 * than a convenience. `child.kill()` is safe by construction — Node reaped the
 * child, so it knows the handle is spent and no-ops — but `process.kill(-pid)`
 * is a raw signal at a number with no such check. After the reap that number is
 * free, and on the one path where the group is ALSO empty (so ESRCH would have
 * been the honest answer) a recycled pid that now leads some unrelated group
 * would take a SIGKILL meant for a linter. It needs pid wraparound to land on a
 * group leader, so it is vanishingly unlikely — but it is unrecoverable and
 * aimed at a stranger, so the caller checks `exited` first rather than paying
 * it. The cost of that choice is that stragglers outliving an already-exited
 * child are left to leave on their own; the grace backstop settles regardless,
 * and this is what `main` did too, where a kill after the reap was a no-op.
 */
function killRun(child: ReturnType<typeof spawnChild>): boolean {
  const pid = child.pid;

  // Unset when the spawn itself failed; there is no process and no group.
  if (pid === undefined) return false;

  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return child.kill("SIGKILL");
  }
}

/**
 * The one place `spawn` is called.
 *
 * Extracted so the call can be wrapped in a `try` without the surrounding
 * promise losing the child's type.
 */
function spawnChild(program: string, args: readonly string[], options: RunCommandOptions) {
  const child = spawn(program, [...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Explicitly off. Stated rather than defaulted, because this is the line
    // that keeps a model-supplied argument from reaching a shell.
    shell: false,
    // A process group of its own, so the timeout can signal the whole run
    // rather than only the process this server happens to have spawned — see
    // `killRun`.
    //
    // Deliberately NOT paired with `child.unref()`, so the parent still waits on
    // this handle rather than handing a linter permission to outlive the server.
    // That is not the whole lifetime story though, and the honest version is
    // that detaching buys the reach of the kill and PAYS for it here: a new
    // group is also a new session, outside this server's controlling terminal,
    // so a signal aimed at OUR group — an interactive Ctrl-C, a supervisor's
    // `kill -- -PGID` — no longer reaches a lint run in flight. Such a run would
    // be orphaned where it would previously have died alongside us, and orphaned
    // without a deadline, since the ceiling above is a parent-side timer.
    //
    // That is the debt this line used to carry, and it is now PAID rather than
    // merely disclosed: the run is registered in `liveChildren` below, and
    // `bin/specguard-mcp.ts` installs SIGINT/SIGTERM handlers that call
    // `killOutstandingRuns` before exiting. The trade the kill's reach was
    // bought with is closed; do not remove either half without restoring the
    // other.
    detached: true,
  });

  // Registered at the single spawn call site, so a run cannot enter the world
  // unregistered. Removed again on the child's own `exit` — see `liveChildren`
  // for why the reap, and not the settle, is the moment that matters.
  liveChildren.add(child);

  return child;
}

/**
 * Which thing failed to run — asked rather than assumed.
 *
 * Node reports a non-existent `cwd` as `ENOENT` on the spawn: the same code and
 * the same shape as a program that is not on PATH. Answering both with "it is not
 * on this server's PATH" tells an operator whose only mistake was the directory
 * to go and change the one thing that was right, and the caller of this function
 * knows the difference is checkable. So on the error path — where an extra `stat`
 * costs nothing — we ask which of the two is actually missing before naming a
 * cause.
 *
 * This is the same reasoning as the non-zero-exit rule above: an outcome that
 * leaves the caller with no verdict must not be described as some other outcome.
 */
function describeSpawnFailure(
  program: string,
  error: NodeJS.ErrnoException,
  options: RunCommandOptions,
): string {
  const cwd = options.cwd;

  // Consulted before the errno, because more than one code means this same thing.
  if (cwd !== undefined && !isDirectory(cwd)) return unusableCwd(program, cwd);

  if (error.code === "ENOENT") {
    const hint = options.notFoundHint === undefined ? "" : ` ${options.notFoundHint}`;
    return `Could not run \`${program}\`: it is not on this server's PATH.${hint}`;
  }

  return `Could not run \`${program}\`: ${error.message}`;
}

function unusableCwd(program: string, cwd: string): string {
  return (
    `Could not run \`${program}\`: its working directory ${JSON.stringify(cwd)} does not exist, ` +
    "or is not a directory. The command itself was not the problem."
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Bounded accumulation of a child's output.
 *
 * An unbounded buffer here would let a linter run over a very large suite —
 * exactly the suites SpecGuard exists for — decide this server's memory
 * ceiling. Truncation is announced in the returned text rather than silent,
 * because a JSON document cut in half must not look like a document that ended.
 */
class OutputBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  get truncated(): boolean {
    return this.#truncated;
  }

  push(chunk: Buffer): void {
    if (this.#truncated) return;

    if (this.#bytes + chunk.byteLength > MAX_OUTPUT_BYTES) {
      this.#chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - this.#bytes));
      this.#truncated = true;
      this.#bytes = MAX_OUTPUT_BYTES;
      return;
    }

    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
  }

  text(): string {
    const body = Buffer.concat(this.#chunks).toString("utf8");
    return this.#truncated ? `${body}\n[truncated at ${MAX_OUTPUT_BYTES} bytes]` : body;
  }
}
