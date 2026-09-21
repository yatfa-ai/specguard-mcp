import { getJsonObject, requireEndpointApiConfig } from "../support/specguard-api.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /version` as a tool — the server's OWN identity, askable at last
 * (shipped: SPGD-1197, specguard `08ab408`; first served by release 0.1.46,
 * `d434c2a` — root-level and unauthenticated by design — `config/routes.rb`
 * mounts it beside `/up` and the schema mirror, exactly because the credential
 * seam under `api/` fails closed and this read is the platform's deliberate
 * no-account exception at the root).
 *
 * == What it answers, and the one distinction the whole tool exists to carry
 *
 * "Which build is answering me?" has a second answer in this bridge, and the
 * two are routinely confused because both are called a version. The
 * `serverInfo.version` in the initialize handshake and the
 * `specguard-mcp/<version>` User-Agent are THIS BRIDGE's build — its own
 * manifest, released on its own cadence (SPGD-1190/1192). The deployment
 * behind `SPECGUARD_ENDPOINT` is a different component built from a different
 * tree, and before this tool nothing here could say which build of IT was
 * answering. The consumers the platform's own controller names — a client
 * author verifying an upgrade took effect, an agent pinning which build's
 * crafted 404/400 message sentences its contract suite asserts, a bug
 * reporter stating which build produced the behavior — are all asking about
 * the DEPLOYMENT, and this tool is their channel.
 *
 * == The two non-happy arms are in the schema's description, not just here
 *
 * `version: null` is an HONEST answer the server deliberately serves (its
 * VERSION file was missing or unreadable at boot — the controller memoizes
 * even the failure): an unverifiable identity beats a 500 from the one
 * endpoint whose whole job is to be askable. This bridge passes it through as
 * `null` and never substitutes a guessed value — inventing one would be the
 * exact defect the nil arm exists to prevent.
 *
 * A 404 means the deployment PREDATES the route: the endpoint is right and
 * the build is old. `describeFailure` cannot know that — a non-contract 404
 * body names no cause, so its canned hint names the endpoint as possibly
 * misconfigured. The description pre-empts the wrong reading: when every
 * other tool works against the same `SPECGUARD_ENDPOINT`, that error is an
 * upgrade request, not a URL fix.
 *
 * == No arguments, no credential — the thin-client shape at its thinnest
 *
 * The endpoint takes no parameters and the route authenticates nothing, so
 * the tool advertises no argument and requires no key: it is the first tool
 * here served by `requireEndpointApiConfig`, and the transport sends no
 * `Authorization` header for it. The body is passed through verbatim —
 * reshaping `{version}` would be a second copy of the platform's own
 * identity answer, one release behind it.
 */
const getServerVersion: ToolDefinition = {
  name: "get_server_version",
  title: "Server version",
  description:
    "Reports WHICH BUILD of the SpecGuard DEPLOYMENT is answering, read from the deployment's own " +
    "unauthenticated root-level `GET /version` — the figure the release bot's VERSION file carries, " +
    'served as `{"version": "0.1.46"}`-shaped JSON and passed through verbatim as `{version}`. ' +
    "This is the SERVER's build, NOT this bridge's: the version in the initialize handshake's " +
    "`serverInfo` and the `specguard-mcp/<version>` User-Agent describe this bridge, a different " +
    "component released on its own cadence, so never read one as the other. Pinning which build's " +
    "crafted 404/400 message sentence a contract suite asserts, verifying that a deployment upgrade " +
    "took effect, or naming the build that produced a behavior is this tool's question — the " +
    "handshake cannot answer it. `version: null` is an honest answer, not an error: the deployment " +
    "is up but cannot say its own build (its VERSION file was missing or unreadable at boot), and " +
    "null is passed through exactly as served — never replaced with a guessed value. A 404 means " +
    "this deployment PREDATES the route: the endpoint is right and the build is old. The error text " +
    "names the endpoint as possibly misconfigured because a non-contract 404 body names no cause — " +
    "when the other tools work against the same endpoint, read that error as 'the deployment needs " +
    "upgrading', not as a wrong URL. Needs NO API key of any kind — the route is unauthenticated by " +
    "design — so it works with `SPECGUARD_ENDPOINT` alone, and it sends no `Authorization` header " +
    "(as does get_intent_schema, the other credential-free read here). Takes no arguments.",
  inputSchema: {
    type: "object",
    // No properties, deliberately — see this file's header. Still CLOSED rather
    // than merely empty, for the reason `registrable-repositories.ts` states:
    // `server.ts` forwards `arguments` unvalidated and `run` ignores them, so
    // an open schema would let an invented argument be silently dropped while
    // the call is answered as if it had been honoured.
    additionalProperties: false,
  },

  async run(_args, context): Promise<ToolResult> {
    const api = requireEndpointApiConfig(context.config);

    const answer = await getJsonObject(api, "/version", {}, context.fetch);

    return {
      text: JSON.stringify(answer, null, 2),
      structured: answer,
    };
  },
};

export default getServerVersion;
