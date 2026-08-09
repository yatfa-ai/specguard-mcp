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

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // `unref` so a hung command's timer cannot by itself hold the process open.
    timer.unref?.();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(new CommandError(describeSpawnFailure(program, error, options))));
    });

    child.on("close", (code, signal) => {
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
        });
      });
    });
  });
};

/**
 * The one place `spawn` is called.
 *
 * Extracted so the call can be wrapped in a `try` without the surrounding
 * promise losing the child's type.
 */
function spawnChild(program: string, args: readonly string[], options: RunCommandOptions) {
  return spawn(program, [...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Explicitly off. Stated rather than defaulted, because this is the line
    // that keeps a model-supplied argument from reaching a shell.
    shell: false,
  });
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
