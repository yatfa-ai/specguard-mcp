import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The teardown path: a run in flight dies WITH the server, not after it.
 *
 * `run-command.ts` spawns every run `detached`, which is what lets the timeout
 * signal a whole `bundle exec` tree instead of just the process it forked. The
 * cost is that the run is then in its own session, so a signal aimed at the
 * server's group — an interactive Ctrl-C, a supervisor's `kill -- -PGID` — no
 * longer reaches it. And it is not merely orphaned: the 120s ceiling is a
 * parent-side timer, so killing the parent destroys the only thing that was
 * going to stop it. A lint of a 20k-example suite then runs to completion with
 * nobody waiting for the answer.
 *
 * These run a REAL process and signal it for real. A stub would be a restatement
 * of my beliefs about signal delivery and process groups, and those beliefs are
 * exactly what is under test — the same reasoning `run-command.test.ts` gives for
 * spawning real children.
 *
 * Each carries an explicit deadline, per this suite's convention: a regression
 * here is a shutdown that hangs or a child that never dies, and an undeadlined
 * hang reports nothing at all.
 */
const FIXTURE = fileURLToPath(new URL("../fixtures/teardown-server.js", import.meta.url));

/**
 * Whether a pid is still there — the one probe both the subject and the control
 * are read with.
 *
 * Signal 0 delivers nothing; it only runs the kernel's "may I signal this?"
 * checks, so ESRCH is the answer to "no such process". EPERM is deliberately
 * read as ALIVE: a process we are not allowed to signal is still a process.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Polls until `pid` is gone, or gives up — so a failure is a fail, not a hang. */
async function waitForExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return !isAlive(pid);
}

interface TornDownServer {
  readonly registered: number;
  readonly control: number;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
}

/**
 * Starts the fixture, waits until both children exist, signals it, and reports
 * what came back.
 *
 * The signal is sent to the fixture's pid ALONE — not to its group. That is the
 * scenario under test: a detached run is in a different group by construction,
 * so a group-directed kill would reach the child by a route that has nothing to
 * do with the handler and would certify a fix that was not there.
 */
async function runAndSignal(signal: "SIGINT" | "SIGTERM"): Promise<TornDownServer> {
  const server = spawn(process.execPath, [FIXTURE], { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  server.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    server.on("exit", (status, onSignal) => resolve({ status, signal: onSignal }));
  });

  const pids = await new Promise<{ registered: number; control: number }>((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error(`fixture never reported READY; stderr: ${stderr}`)), 10_000);

    server.stderr.on("data", () => {
      const match = /READY registered=(\d+) control=(\d+)/.exec(stderr);
      if (match?.[1] === undefined || match[2] === undefined) return;

      clearTimeout(giveUp);
      resolve({ registered: Number(match[1]), control: Number(match[2]) });
    });
  });

  server.kill(signal);
  const outcome = await exited;

  return { ...pids, ...outcome, stdout };
}

describe("teardown — a run in flight dies with the server", () => {
  it("kills the registered run, and leaves an unregistered one alone", { timeout: 20_000 }, async () => {
    const { registered, control, stdout } = await runAndSignal("SIGTERM");

    try {
      // The subject. Before the handler existed this child outlived the server
      // in its own session, with the only deadline that would ever have stopped
      // it destroyed along with the parent that held it.
      assert.ok(
        await waitForExit(registered),
        `expected the registered run (pid ${registered}) to be dead after teardown`,
      );

      // THE POSITIVE CONTROL, and the reason the assertion above is worth
      // anything. It is the same probe, in the same test, against a child with
      // the same `detached: true` topology that simply never entered the
      // registry — so it proves the probe can still report "alive". Without it a
      // probe that answered ESRCH for its own reasons (a mis-parsed pid, a
      // platform quirk) would certify a drain that never ran.
      //
      // It is also the tighter claim: the drain kills what it registered, not
      // every process it can reach.
      assert.ok(
        isAlive(control),
        `expected the unregistered control (pid ${control}) to survive teardown — ` +
          "if it did not, the probe cannot distinguish alive from dead and the assertion above is vacuous",
      );

      // On stdio, stdout IS the JSON-RPC channel: a diagnostic written there is
      // framed as a protocol message and reaches the client as an unexplained
      // disconnect rather than as the shutdown it was. The handler's own line
      // goes to stderr, and this is what holds it there.
      assert.equal(stdout, "", `expected nothing on stdout during teardown, got ${JSON.stringify(stdout)}`);
    } finally {
      // The control is detached and outlives this test by design, so it has to
      // be cleaned up explicitly — a leaked one would sit in the process table
      // for its full lifetime on every run of the suite.
      try {
        process.kill(control, "SIGKILL");
      } catch {
        // Already gone: the assertion above has said so far more loudly.
      }
    }
  });

  it("exits 143 on SIGTERM and 130 on SIGINT, so a supervisor reads a signal not a crash", { timeout: 20_000 }, async () => {
    // The conventional 128 + signo. It matters because the alternative — dying
    // on the default disposition, or exiting 1 — tells a supervising MCP client
    // the server FAILED, and a client that reads a crash may restart or report a
    // fault where the operator simply pressed Ctrl-C.
    for (const [signal, expected] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const) {
      const { status, signal: diedOn, control } = await runAndSignal(signal);

      try {
        assert.equal(
          status,
          expected,
          `expected ${signal} to exit ${expected}, got status ${String(status)} / signal ${String(diedOn)}`,
        );
        // Exited under its own power rather than being killed by the default
        // handler — which is what makes the status above ours to promise.
        assert.equal(diedOn, null);
      } finally {
        try {
          process.kill(control, "SIGKILL");
        } catch {
          // Nothing to clean up.
        }
      }
    }
  });
});
