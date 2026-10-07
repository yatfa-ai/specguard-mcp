import { spawn } from "node:child_process";
import { outstandingRunPids, runCommand } from "../../src/support/run-command.js";
import { installTeardown } from "../../src/support/teardown.js";

/**
 * A stand-in for the server, for the teardown tests.
 *
 * It is a real process that does what `bin/specguard-mcp.ts` does — installs the
 * REAL `installTeardown` — and then holds a real run in flight, so a test can
 * signal it and look at what survived. `bin/` itself cannot be used: importing
 * it runs `main()`, which connects a stdio transport and would make the test
 * about the MCP handshake rather than about teardown. Retyping the handler here
 * instead would be worse — it would assert that a COPY of the logic works while
 * the shipped one went unread — which is why the handler lives in
 * `src/support/teardown.ts` and both callers import it.
 *
 * It holds TWO long-lived children, and the difference between them is the whole
 * point:
 *
 *   - a REGISTERED run, started through `runCommand`, which the drain must kill;
 *   - an UNREGISTERED control, spawned directly with the same `detached: true`
 *     topology, which nothing is supposed to kill.
 *
 * The control is what stops the test passing vacuously. Both pids are probed the
 * same way by the same test, so a probe that could only ever report "gone" — a
 * pid read wrong, a probe that throws for its own reasons — fails on the control
 * instead of quietly certifying the fix.
 *
 * BOTH CHILDREN OUTLIVE THE TEST'S OWN DEADLINE on purpose, following the
 * convention in `run-command.test.ts`: give a fixture a lifetime shorter than the
 * deadline and the test passes for a process that stopped on its own, which is
 * an assertion about the fixture rather than about the code under test.
 *
 * NOTHING IS WRITTEN TO STDOUT — the one line this prints goes to stderr. That
 * is not incidental tidiness: a test asserts this process's stdout is empty
 * across a teardown, standing in for the JSON-RPC channel that a stray write
 * would corrupt.
 */
const CHILD_LIFETIME_MS = 30_000;

installTeardown();

// The control: same `detached` shape as a real run, but spawned directly rather
// than through `runCommand`, so it never enters the registry. `unref` so it does
// not hold this process open, and its own session means it survives this
// process's death — leaving it observable after the teardown it must not be
// caught by.
const control = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${CHILD_LIFETIME_MS})`], {
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});
control.unref();

// The registered runs. `TEARDOWN_RUNS` (default 1, which is the behaviour every
// pre-existing example relies on) says how many to hold in flight; 0 gives a
// server with nothing running, which is what the zero-run silence is read
// against. A generous timeout that will never fire: the deadline is not what is
// under test here, teardown is.
const RUNS = Number(process.env.TEARDOWN_RUNS ?? "1");

for (let index = 0; index < RUNS; index += 1) {
  const run = runCommand([process.execPath, "-e", `setTimeout(() => {}, ${CHILD_LIFETIME_MS})`], {
    timeoutMs: CHILD_LIFETIME_MS,
  });

  // The drain kills this run, so the promise may reject on the way out. Swallowed
  // so an unhandled rejection cannot replace the exit status the test is reading.
  run.catch(() => {});
}

// With no run in flight nothing else holds the event loop open (the control is
// unref'd), and a fixture that exits on its own is not there to be signalled.
// The real stdio server is kept alive by its transport; this stands in for that.
setInterval(() => {}, 1_000);

// The runs' pids are not known until `spawn` returns, and the registry is where
// they are published. Announced only once every pid exists, so the test never
// parses a half-built line. `registered` is the first run's pid, or 0 when none
// was asked for.
const announce = setInterval(() => {
  const pids = outstandingRunPids();
  if (pids.length < RUNS || control.pid === undefined) return;

  clearInterval(announce);
  process.stderr.write(`READY registered=${pids[0] ?? 0} control=${control.pid}\n`);
}, 10);
