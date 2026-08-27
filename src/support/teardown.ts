import { killOutstandingRuns } from "./run-command.js";

/**
 * Kill the runs we started before going away.
 *
 * `run-command.ts` spawns every run `detached`, which is what lets a timeout
 * signal the whole process tree rather than only the process we forked. The
 * cost is that a detached child is in its own session, outside this server's
 * controlling terminal, so a signal aimed at OUR group — an interactive Ctrl-C,
 * a supervisor's `kill -- -PGID` — does not reach a lint run in flight. Without
 * the handlers below such a run is not merely orphaned but UNBOUNDED: the
 * `DEFAULT_COMMAND_TIMEOUT_MS` ceiling is a parent-side timer, so killing the
 * parent destroys the only thing that was ever going to stop it, and a lint of a
 * 20k-example suite goes on burning CPU with nobody waiting for its answer.
 *
 * == Why this is not written inline in `bin/specguard-mcp.ts`
 *
 * It lives here so a test can install the REAL handler. `bin/` runs `main()` on
 * import, so a test that imported it would connect a transport rather than
 * exercise a teardown, and the alternative — retyping the handler inside a test
 * fixture — would assert that a COPY of the logic works while the shipped one
 * went unread. `bin/` is left as the one place the policy is applied, which is
 * the same split it already makes for the transport.
 *
 * DIAGNOSTICS GO TO STDERR, without exception. On stdio, stdout IS the JSON-RPC
 * protocol channel: a line written there is framed as a message on the way out
 * and corrupts the stream the client is still reading, surfacing as an
 * unexplained disconnect rather than as the shutdown it actually was.
 *
 * NOTHING HERE WAITS. `killOutstandingRuns` sends SIGKILL and returns; SIGKILL
 * cannot be refused, so there is no acknowledgement worth blocking a shutdown
 * for. A teardown path that waits is a teardown path that can hang, which is the
 * failure this handler exists to prevent rather than one to introduce.
 */
export function installTeardown(): void {
  let tearingDown = false;

  const teardown = (signal: "SIGINT" | "SIGTERM", status: number) => {
    // A second Ctrl-C while the first is still unwinding must not re-enter the
    // drain — the registry is already empty and the pids in it already spent.
    if (tearingDown) return;
    tearingDown = true;

    const killed = killOutstandingRuns();

    if (killed > 0) {
      process.stderr.write(
        `specguard-mcp: ${signal} received, killed ${killed} run${killed === 1 ? "" : "s"} still in flight\n`,
      );
    }

    // The conventional 128 + signo, so a supervisor reads "died on SIGINT"
    // rather than an ordinary failure. Exiting explicitly rather than restoring
    // the default disposition and re-signalling ourselves: we hold no other
    // teardown obligation, and an explicit status cannot be lost to a handler
    // installed elsewhere.
    process.exit(status);
  };

  process.on("SIGINT", () => teardown("SIGINT", 130));
  process.on("SIGTERM", () => teardown("SIGTERM", 143));
}
