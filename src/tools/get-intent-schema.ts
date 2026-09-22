import type { ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { getJsonObject, getText, requireEndpointApiConfig } from "../support/specguard-api.js";
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
 * document view, both derived from the one fetched value as `tools/types.ts`
 * requires. The text half is what keeps the mirror's promise intact across
 * this bridge: a consumer digesting what it received gets the same digest the
 * platform's own spec asserts, which a re-encode or a pretty-print would
 * destroy. The structured half is the shape an agent actually reads a
 * contract from — and `application/schema+json` carries the `+json`
 * structured-syntax suffix precisely so a client dispatching on "is this
 * JSON" still parses it.
 *
 * A 2xx body that will not parse is a genuinely malformed mirror and is
 * reported as THAT, naming the route rather than the endpoint variable: the
 * response arrived, so the configuration is not the thing to go and fix.
 *
 * == The enforcement identity beside it: a SECOND body, whose disagreement IS
 *    the check
 *
 * Since SPGD-1316 the deployment also answers WHICH CONTRACT IT ENFORCES:
 * `GET /version` carries `schema_sha256` — the digest of the vendored document
 * this process validates every ingested annotation against — and
 * `schema_origin`, the repo-relative path those bytes come from. The pairing
 * the platform's own controller names is exact: the same bytes are fetchable,
 * unauthenticated, from this same host at the mirror route above, so a client
 * can digest them itself and check the served answer. This tool is where that
 * loop closes. Until now the bridge carried those keys invisibly —
 * `get_server_version` passed them through, but the tool whose question IS the
 * contract named no comparison target, and `schema_sha256` appeared nowhere on
 * this surface — so the question "is the reference I read the contract that
 * will judge me?" was underivable from this toolset at all.
 *
 * `run()` now makes BOTH fetches and serves the two facts side by side. The
 * identity fetch is the exact helper on the exact route `get_server_version`
 * uses — `getJsonObject` against `/version` — so nothing new is invented: no
 * second tool on that route, no new transport, no new credential kind, no new
 * dependency. What is new is the shape of the answer: `structured` becomes an
 * envelope, `{ schema, enforced }`, with the server's own key names preserved
 * verbatim so the family cross-check is one vocabulary.
 *
 * The one-body doctrine above is RECONCILED here, not violated: `text` and
 * `structured.schema` are two views of the ONE mirror body and must not
 * disagree, while the whole point of `enforced` is that it CAN — a mismatch
 * between a SHA-256 digest over `text` and `enforced.schema_sha256` IS the
 * finding, and `enforced.schema_origin` is the fact that says which half of
 * the disagreement is the server's. The tool serves both facts and never
 * judges: refusing or warning on a mismatch would blind the agent in exactly
 * the mangled-transport case where both facts matter most, and the judgment
 * is the reader's.
 *
 * == The identity leg is best-effort by design
 *
 * Its failure must never fail the tool whose primary answer is the document.
 * Any of — a deployment predating the identity channel (its `/version` omits
 * the keys), a non-2xx answer, a network failure, a body that will not parse —
 * yields `enforced: null` with the document answer still standing in full. No
 * throw, no sentinel. `null` means "this deployment could not say", and the
 * description says so in the reader's terms. This inherits the server's own
 * nil doctrine in both directions: a current deployment whose vendored schema
 * cannot be read answers `schema_sha256: null` at 200 — an honest null INSIDE
 * a present envelope, passed through as served — while `enforced: null` is
 * the envelope-level absence, the deployment having said nothing at all. The
 * two nulls answer different questions and are kept apart.
 *
 * == No arguments, no credential
 *
 * Neither route takes parameters and neither authenticates anything, so the
 * tool advertises no argument and binds no key — the second consumer of
 * `requireEndpointApiConfig` after `get_server_version`, sending no
 * `Authorization` header on EITHER fetch even when every key variable is set.
 * A contract is not a secret, and presenting a key an endpoint does not read
 * is not authentication, it is leakage.
 */
const SCHEMA_PATH = "/schemas/open-test-intent.v1.json";

/**
 * The identity route, beside the mirror route above — the exact path
 * `get_server_version` reads, fetched here with the exact helper that tool
 * uses. One route, one tool each: this is not a second tool on `/version`, it
 * is the contract tool carrying the comparison target its own description
 * invites the reader to compute.
 */
const VERSION_PATH = "/version";

/**
 * The identity as the server spells it — its own key names, verbatim, so a
 * consumer comparing across the family never translates between vocabularies.
 * The values are `unknown` on purpose: a thin client passes through whatever
 * the deployment served, including its honest null digest.
 */
interface EnforcedIdentity {
  schema_sha256: unknown;
  schema_origin: unknown;
}

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
    "answer is an envelope carrying the whole document in both shapes, derived from one fetched " +
    "body so they cannot disagree: `structured.schema` is it parsed, which is what to read the " +
    "field rules and any enumerated values off; `text` is the served bytes UNCHANGED, so a digest " +
    "taken over it matches the canonical document's. Beside the document, `structured.enforced` " +
    "carries the enforcement identity the deployment itself serves from its `GET /version` — " +
    "`schema_sha256`, the digest of the contract it actually enforces, and `schema_origin`, where " +
    "those bytes come from on the server — which makes the end-to-end check derivable from this " +
    "one tool: take a SHA-256 digest over `text` and compare it with `enforced.schema_sha256`. A " +
    "match means the reference you read IS the contract that will judge you; a mismatch means the " +
    "bytes you received are NOT what the deployment enforces, and you must not author annotations " +
    "against them — `enforced.schema_origin` names which half of the disagreement is the " +
    "server's. The tool serves both facts side by side and never judges: a mismatch is never " +
    "refused or warned here, because the judgment is the reader's and a hard failure would blind " +
    "you in exactly the mangled-transport case where both facts matter most. `enforced` is null " +
    "when this deployment could not say — its `/version` omits the identity keys (a build " +
    "predating the identity channel), answers non-2xx, or the identity fetch fails entirely — and " +
    "the document answer still stands in full; null means 'this deployment could not say', never " +
    "a sentinel. Nothing here restates the schema's contents — the answer is the contract, and " +
    "any prose copy of it would be one release behind. A 404 means this deployment PREDATES the " +
    "mirror route: the endpoint is right and the build is old. The error text names the endpoint " +
    "as possibly misconfigured because a non-contract 404 body names no cause — when the other " +
    "tools work against the same endpoint, read it as 'the deployment needs upgrading', not as a " +
    "wrong URL. Needs NO API key of any kind — both routes it reads are unauthenticated by " +
    "design, because a contract is not a secret — so it works with SPECGUARD_ENDPOINT alone and " +
    "sends no Authorization header. Takes no arguments.",
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
    const schema = parseSchemaDocument(document, api.endpoint);

    return {
      // The served bytes, unchanged — see this file's header. The document's
      // two views come off this ONE value; `enforced` is the deliberate SECOND
      // body, whose possible disagreement with a digest over this text IS the
      // check.
      text: document,
      structured: { schema, enforced: await enforcedIdentity(api, context.fetch) },
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
 * mode bolted beside it: a schema document's root is a JSON object, and a
 * mirror serving an array or a bare scalar is malformed in exactly the way
 * this sentence describes.
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

/**
 * The enforcement identity, fetched BEST-EFFORT — the `enforced` half of the
 * envelope.
 *
 * Success is narrow and everything else is the same `null`. The narrow path: a
 * 2xx JSON object carrying BOTH identity keys. A build predating the identity
 * channel answers `{"version": …}` alone, and an envelope built over a missing
 * key would be a fabricated half-answer rather than an honest absence, so the
 * pair is required together — the same all-or-nothing choice the singular/
 * plural branch in the transport makes. The values are copied through verbatim
 * under the server's own key names, INCLUDING a null digest: a deployment that
 * cannot currently read its vendored schema answers `schema_sha256: null` at
 * 200 by its own doctrine, and that honesty is not this bridge's to improve —
 * a present envelope saying "I enforce from this origin and cannot currently
 * read it" is strictly more actionable than the envelope-level null below.
 *
 * Everything else — a non-2xx answer, an unreachable deployment, a timeout, a
 * body that will not parse or is not an object, a `/version` that predates the
 * route entirely — lands in the catch and returns `null`. That is deliberate:
 * the identity leg is best-effort BY DESIGN, and its failure must never fail
 * the tool whose primary answer is the document. `null` means "this deployment
 * could not say", never a sentinel.
 */
async function enforcedIdentity(
  api: ApiConfig,
  fetchImpl: typeof globalThis.fetch,
): Promise<EnforcedIdentity | null> {
  try {
    const version = await getJsonObject(api, VERSION_PATH, {}, fetchImpl);

    if ("schema_sha256" in version && "schema_origin" in version) {
      return {
        schema_sha256: version["schema_sha256"],
        schema_origin: version["schema_origin"],
      };
    }

    return null;
  } catch {
    return null;
  }
}

export default getIntentSchema;
