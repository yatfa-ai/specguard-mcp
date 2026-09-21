import { ApiError } from "../errors.js";
import { getText, requireEndpointApiConfig } from "../support/specguard-api.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * The OpenTestIntent contract, READABLE — the reference this bridge was
 * missing beside the judge it already had.
 *
 * == The gap this closes, and why refusals could not close it
 *
 * SpecGuard is structurally gated on `@intent:` annotations existing, and the
 * only thing this bridge could say about one until now was whether an
 * annotation the agent HAD ALREADY WRITTEN was wrong. `lint_intent_annotations`
 * is a judge, not a reference: an agent authoring a new annotation had to
 * guess, write the guess to a file, lint it, and read the refusal.
 *
 * Refusals are an INCOMPLETE teacher, and the sharpest asymmetry is that a
 * WRONG enumerated value names the legal set in its error while an ABSENT one
 * does not — so the fastest way to learn the contract through a judge is to
 * submit a value you believe is invalid, which is a perverse thing for a
 * toolset to reward. Worse, the schema declares an OPTIONAL property, and an
 * optional property is underivable in principle from that surface: `required`
 * never names it, and a closed-object refusal only ever reports the key you
 * DID send. No input to the linter at any value causes it to be mentioned.
 * That is the hole this tool exists to fill, and it is why this is a read of
 * the contract rather than a nicer error message on the judge.
 *
 * == It MIRRORS; it does not carry a copy
 *
 * The bytes come from the deployment's own root-level, unauthenticated schema
 * mirror — `SchemasController`, which renders the vendored document verbatim
 * with an explicit `application/schema+json` content type and whose request
 * spec pins the response to the file's bytes by digest. Vendoring the schema
 * into this repo instead would mint a THIRD copy of a document whose entire
 * design is one canonical source plus byte-identical mirrors, and it would
 * drift silently — a bridge that answers from its own copy answers about
 * itself, not about the deployment the agent is being judged by.
 *
 * For the same reason the contract's contents are not transcribed into this
 * file's description, the README, or a test name. A second copy of a field
 * list is one release behind the schema by construction. The tool is
 * cross-referenced by name from elsewhere; its ANSWER is where the fields
 * live.
 *
 * == Why the body is fetched raw, and why both shapes come off one value
 *
 * `getText` rather than `getJsonObject`, and the reason is a diagnosis rather
 * than a preference: `requestJson`'s not-JSON sentence tells the operator to
 * check that the endpoint points at a SpecGuard deployment "and not, say, a
 * proxy or login page" — the wrong remedy for a response that arrived
 * perfectly correctly and simply is not what that helper assumed. So this
 * shares the deadline and the failure diagnosis and owns its own success
 * handling, exactly as `deleteJson` does for its empty `204`.
 *
 * The verbatim body is then served as the text view and PARSED ONCE for the
 * structured view, both derived from the one fetched value as
 * `tools/types.ts` requires. The text half is what keeps the mirror's promise
 * intact across this bridge: a consumer digesting what it received gets the
 * same digest the platform's own spec asserts, which a re-encode or a
 * pretty-print would destroy. The structured half is the shape an agent
 * actually reads a contract from — and `application/schema+json` carries the
 * `+json` structured-syntax suffix precisely so a client dispatching on "is
 * this JSON" still parses it.
 *
 * A 2xx body that will not parse is a genuinely malformed mirror and is
 * reported as THAT, naming the route rather than the endpoint variable: the
 * response arrived, so the configuration is not the thing to go and fix.
 *
 * == No arguments, no credential
 *
 * The route takes no parameters and authenticates nothing, so the tool
 * advertises no argument and binds no key — the second consumer of
 * `requireEndpointApiConfig` after `get_server_version`, sending no
 * `Authorization` header even when every key variable is set. A contract is
 * not a secret, and presenting a key an endpoint does not read is not
 * authentication, it is leakage.
 */
const SCHEMA_PATH = "/schemas/open-test-intent.v1.json";

const getIntentSchema: ToolDefinition = {
  name: "get_intent_schema",
  title: "OpenTestIntent schema",
  description:
    "Serves the OpenTestIntent schema document itself — the CONTRACT an `@intent:` annotation is " +
    "validated against — read live from the SpecGuard deployment's own unauthenticated root-level " +
    "schema mirror, which serves the canonical document's bytes verbatim. Call this BEFORE writing " +
    "or editing an annotation: it is the reference, while lint_intent_annotations is the judge, and " +
    "a judge can only tell you that something you already wrote is wrong. Reading the contract is " +
    "also the ONLY way to learn parts of it: a refusal names the legal values of a field you got " +
    "wrong but says nothing about a field you omitted, and an OPTIONAL property can never appear in " +
    "any refusal at all — nothing you submit, at any value, causes the linter to mention it. The " +
    "answer carries the whole document in both shapes, derived from one fetched body so they cannot " +
    "disagree: `structured` is it parsed, which is what to read the field rules and any enumerated " +
    "values off; `text` is the served bytes UNCHANGED, so a digest taken over it matches the " +
    "canonical document's. Nothing here restates the schema's contents — the answer is the contract, " +
    "and any prose copy of it would be one release behind. A 404 means this deployment PREDATES the " +
    "mirror route: the endpoint is right and the build is old. The error text names the endpoint as " +
    "possibly misconfigured because a non-contract 404 body names no cause — when the other tools " +
    "work against the same endpoint, read it as 'the deployment needs upgrading', not as a wrong " +
    "URL. Needs NO API key of any kind — the route is unauthenticated by design, because a contract " +
    "is not a secret — so it works with SPECGUARD_ENDPOINT alone and sends no Authorization header. " +
    "Takes no arguments.",
  inputSchema: {
    type: "object",
    // No properties, deliberately — a document has no ask to narrow. Still
    // CLOSED rather than merely empty, for the reason `get-server-version.ts`
    // states: `server.ts` forwards `arguments` unvalidated and `run` ignores
    // them, so an open schema would let an invented argument be silently
    // dropped while the call is answered as if it had been honoured.
    additionalProperties: false,
  },

  async run(_args, context): Promise<ToolResult> {
    const api = requireEndpointApiConfig(context.config);

    const document = await getText(api, SCHEMA_PATH, context.fetch);

    return {
      // The served bytes, unchanged — see this file's header. Both views come
      // off this ONE value.
      text: document,
      structured: parseSchemaDocument(document, api.endpoint),
    };
  },
};

/**
 * The parse, with the diagnosis this route actually needs.
 *
 * Deliberately NOT `requestJson`'s: its sentence sends the operator to check
 * `SPECGUARD_ENDPOINT` for pointing at a proxy or a login page, and a 200 from
 * the schema route is evidence AGAINST that reading — the deployment answered,
 * on the path, with a status that says it meant to. What is wrong is the
 * document, so the message says the document, and names the route so the
 * report has somewhere to go.
 *
 * The object narrowing is part of the same answer rather than a second failure
 * mode bolted beside it: `ToolResult.structured` is a `Record<string, unknown>`,
 * a schema document's root is a JSON object, and a mirror serving an array or a
 * bare scalar is malformed in exactly the way this sentence describes.
 */
function parseSchemaDocument(body: string, endpoint: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(
      `${endpoint}${SCHEMA_PATH} answered successfully but the document it served is not valid ` +
        "JSON. The route was reached and answered, so this is a malformed schema mirror on the " +
        "deployment rather than a configuration problem on this side.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(
      `${endpoint}${SCHEMA_PATH} answered successfully but the document it served is not a JSON ` +
        "object, which a schema document's root must be. The route was reached and answered, so " +
        "this is a malformed schema mirror on the deployment rather than a configuration problem " +
        "on this side.",
    );
  }

  return parsed as Record<string, unknown>;
}

export default getIntentSchema;
