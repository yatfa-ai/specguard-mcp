import { spawn } from "node:child_process";
import { CommandError } from "../errors.js";

export interface CommandResult {
  /** The process's exit code, or `null` when a signal killed it. */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
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
    const child = spawn(program, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Explicitly off. Stated rather than defaulted, because this is the line
      // that keeps a model-supplied argument from reaching a shell.
      shell: false,
    });

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
      finish(() =>
        reject(
          new CommandError(
            error.code === "ENOENT"
              ? `Could not run \`${program}\`: it is not on this server's PATH. ` +
                "Set SPECGUARD_LINT_COMMAND to the command that runs it here " +
                '(for a bundled Ruby project that is usually "bundle exec specguard-lint").'
              : `Could not run \`${program}\`: ${error.message}`,
          ),
        ),
      );
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

        resolve({ code, signal, stdout: stdout.text(), stderr: stderr.text() });
      });
    });
  });
};

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
