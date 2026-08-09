#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";

/**
 * The stdio entrypoint — the only place a transport is named.
 *
 * SPGD-310 scopes stdio and puts HTTP/SSE in a later follow-up. Keeping the
 * choice here rather than inside `createServer` is what makes that follow-up a
 * sibling of this file instead of a change to the server.
 *
 * NOTHING MAY BE WRITTEN TO STDOUT. On stdio, stdout IS the protocol channel:
 * a stray `console.log` — a debug line, a deprecation notice — is framed as a
 * JSON-RPC message and corrupts the stream, and the failure surfaces to the
 * user as an unexplained disconnect. Every diagnostic below goes to stderr,
 * which MCP clients collect as the server's log.
 *
 * The server itself is built with no I/O and no validation of anything, so
 * `createServer` cannot fail on a missing SPECGUARD_API_KEY — that is checked
 * by the tools that need it, at call time. A server that refused to start
 * without a key would take the lint tool, which needs no key at all, down with
 * it.
 */
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("specguard-mcp: ready on stdio\n");
}

// A rejection anywhere in the tool path is already caught and returned as a
// tool error; this is the backstop for the connection itself. It exits non-zero
// so a supervising client reports a dead server rather than a silent one.
main().catch((error: unknown) => {
  process.stderr.write(
    `specguard-mcp: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
