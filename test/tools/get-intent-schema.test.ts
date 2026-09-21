import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import getIntentSchema from "../../src/tools/get-intent-schema.js";
import { rejects, stubFetch, stubSlowFetch, toolContext } from "../support/stubs.js";

/**
 * The environment this tool exists for: an endpoint and NO keys — the same one
 * `get-server-version.test.ts` names, for the same reason. The schema mirror
 * authenticates nothing, so demanding a key would invent a requirement the
 * deployment does not have.
 */
const ENDPOINT_ONLY_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
};

/**
 * A SERVED FIXTURE, not a second source of truth — and the distinction is
 * load-bearing, because this repo deliberately holds no schema knowledge and
 * this file must not give it any.
 *
 * It stands in for the bytes the mirror hands back, so the tool has something
 * to pass through. NOTHING below asserts its CONTENT: every expectation is
 * computed from this string at test time, so the day the real document gains a
 * field, renames one, or changes an enumeration, these tests keep asserting the
 * same properties and none of them has to be edited. A fixture whose contents
 * were transcribed into assertions would be exactly the drifting copy the tool
 * refuses to vendor.
 *
 * The formatting is deliberately NOT what `JSON.stringify` produces — aligned
 * values, two-space indent, a trailing newline — so "byte-for-byte" below can
 * actually fail. A fixture already in canonical form would be satisfied by a
 * re-encode, which is the one thing that must not happen to it.
 */
const SERVED_DOCUMENT = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://example.invalid/schemas/open-test-intent.v1.json",
  "title": "OpenTestIntent v1",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "entity":        { "type": "string", "minLength": 2 },
    "action":        { "type": "string", "minLength": 2 },
    "behavior":      { "type": "string", "minLength": 15 },
    "layer":         { "type": "string", "enum": ["unit", "integration", "request", "system"] },
    "preconditions": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["entity", "action", "behavior", "layer"]
}
`;

/**
 * A SECOND document of the same SHAPE and none of the same names.
 *
 * This is what proves the assertions below are derived rather than
 * coincidentally true of one string: an implementation that recognised the real
 * document — or that answered from a copy of it — passes every check against
 * the fixture above and fails every check against this one. The tool must serve
 * whatever the mirror serves, which is the whole of its contract.
 */
const OTHER_DOCUMENT = `{"type":"object","properties":{` +
  `"subject":{"type":"string"},` +
  `"tier":{"type":"string","enum":["alpha","omega"]},` +
  `"annotations":{"type":"array","items":{"type":"string"}}},` +
  `"required":["subject","tier"]}`;

/** The document's own property map, read out of whatever was served. */
function propertiesOf(document: Record<string, unknown>): Record<string, unknown> {
  const properties = document["properties"];
  assert.ok(
    typeof properties === "object" && properties !== null && !Array.isArray(properties),
    "the served document declares no property map, so the checks below would verify nothing",
  );
  return properties as Record<string, unknown>;
}

/** The names the document lists as required, read out of whatever was served. */
function requiredOf(document: Record<string, unknown>): string[] {
  const required = document["required"];
  assert.ok(
    Array.isArray(required) && required.every((name) => typeof name === "string"),
    "the served document declares no required list, so the checks below would verify nothing",
  );
  return required as string[];
}

/**
 * The properties a refusal can NEVER name: declared, but absent from `required`.
 *
 * Computed, never listed. This is the census the whole ticket turns on — a
 * closed-object validator reports only the key you DID send and `required`
 * names only what is mandatory, so an optional property appears in no refusal
 * at any input. Naming one here would make the test a restatement of the
 * contract; deriving it makes the test a claim about the TOOL.
 */
function optionalPropertiesOf(document: Record<string, unknown>): string[] {
  const required = new Set(requiredOf(document));
  return Object.keys(propertiesOf(document)).filter((name) => !required.has(name));
}

/** The properties constrained to an enumeration, read out of whatever was served. */
function enumeratedPropertiesOf(document: Record<string, unknown>): [string, unknown[]][] {
  return Object.entries(propertiesOf(document)).flatMap(([name, schema]) => {
    if (typeof schema !== "object" || schema === null) return [];
    const values = (schema as Record<string, unknown>)["enum"];
    return Array.isArray(values) ? [[name, values] as [string, unknown[]]] : [];
  });
}

async function answer(body: string) {
  return getIntentSchema.run(
    {},
    toolContext({ env: ENDPOINT_ONLY_ENV, fetch: stubFetch({ body }).fetch }),
  );
}

describe("get_intent_schema", () => {
  it("asks the deployment's ROOT-LEVEL schema mirror with a GET, from a keys-free environment", async () => {
    const http = stubFetch({ body: SERVED_DOCUMENT });

    await getIntentSchema.run({}, toolContext({ env: ENDPOINT_ONLY_ENV, fetch: http.fetch }));

    const request = http.requests[0];
    // Root-level: NOT under /api/v1. The platform puts its no-account reads
    // outside the credential seam on purpose, and a bridge that looked for this
    // one under the API prefix would 404 against a perfectly current deployment.
    assert.equal(request?.url, "https://sg.example.com/schemas/open-test-intent.v1.json");
    assert.ok(!request.url.includes("/api/v1"), "the mirror is root-level, not under /api/v1");
    assert.equal(request?.method, "GET");
  });

  it("sends no Authorization header even when EVERY key variable is set — it never borrows a credential", async () => {
    // The property `get_server_version` pins, asserted again here because it is
    // a property of THIS tool's config seam and not something inherited by
    // proximity: a contract is not a secret, and presenting a key the endpoint
    // does not read is not authentication, it is leakage.
    const http = stubFetch({ body: SERVED_DOCUMENT });

    await getIntentSchema.run(
      {},
      toolContext({
        env: {
          ...ENDPOINT_ONLY_ENV,
          SPECGUARD_API_KEY: "sgk_test",
          SPECGUARD_USER_API_KEY: "sgu_test",
          SPECGUARD_AGENT_API_KEY: "sga_test",
        },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], undefined);
    assert.ok(
      !("authorization" in (http.requests[0]?.headers ?? {})),
      "no Authorization header at all",
    );
  });

  it("announces that it accepts the media type this route actually serves", async () => {
    // The mirror answers `application/schema+json` — the media type draft-07
    // registers for a schema document. Rails' `render plain:` with an explicit
    // content type does not negotiate, so a narrower header would still be
    // ANSWERED; it would simply be a false claim about what this client takes.
    // Pinned here so the claim is deliberate rather than incidental.
    const http = stubFetch({ body: SERVED_DOCUMENT });

    await getIntentSchema.run({}, toolContext({ env: ENDPOINT_ONLY_ENV, fetch: http.fetch }));

    const accept = http.requests[0]?.headers["accept"] ?? "";
    assert.match(accept, /\bapplication\/schema\+json\b/);
    // And it did not narrow to the schema type alone: every other tool on this
    // transport still reads JSON over the same header.
    assert.match(accept, /\bapplication\/json\b/);
  });

  it("returns the served body BYTE-FOR-BYTE as text", async () => {
    // The mirror's promise is byte equality with the canonical document —
    // SpecGuard's own request spec asserts it by digest — so a consumer
    // digesting what this bridge hands back must get the same digest. Any
    // re-encode, reformat or pretty-print breaks that, and the fixture is
    // deliberately not in canonical form so this can catch one.
    const result = await answer(SERVED_DOCUMENT);

    assert.equal(result.text, SERVED_DOCUMENT);
    // Stated the other way too, because the failure mode is specifically a
    // round trip through the parser that happens to look right.
    assert.notEqual(result.text, JSON.stringify(JSON.parse(SERVED_DOCUMENT)));
    assert.notEqual(result.text, JSON.stringify(JSON.parse(SERVED_DOCUMENT), null, 2));
  });

  it("serves the parsed document as structured, and the two views come off the one body", async () => {
    const result = await answer(SERVED_DOCUMENT);

    // `deepEqual` against the PARSED fixture rather than a hand-listed subset:
    // this bridge is a thin client, so any reshaping — narrowing the document,
    // lifting a field, wrapping it in an envelope — has to fail rather than be
    // reported as a nicer answer.
    assert.deepEqual(result.structured, JSON.parse(SERVED_DOCUMENT));
    // One fetched body, two views — so they cannot come to disagree.
    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("carries the document's own vocabulary: its required list and its property map", async () => {
    // Derived from the SERVED fixture, never restated: the assertion is that
    // the tool's answer exposes what the document declares, which stays true
    // when the real document changes.
    const result = await answer(SERVED_DOCUMENT);
    const served = result.structured ?? {};

    const required = requiredOf(served);
    const properties = propertiesOf(served);

    assert.ok(required.length > 0, "the fixture declares no required fields to check");
    for (const name of required) {
      assert.ok(
        name in properties,
        `the answer names ${name} as required but does not describe it in the property map`,
      );
    }
  });

  it("carries the enumeration of every enum-constrained field, which a refusal only names when you get one wrong", async () => {
    const result = await answer(SERVED_DOCUMENT);
    const served = result.structured ?? {};

    const enumerated = enumeratedPropertiesOf(served);
    assert.ok(enumerated.length > 0, "the fixture constrains no field to an enumeration");

    for (const [name, values] of enumerated) {
      assert.deepEqual(
        (propertiesOf(served)[name] as Record<string, unknown>)["enum"],
        values,
        `${name}'s enumeration did not survive into the answer`,
      );
      assert.ok(values.length > 0, `${name} carries an empty enumeration`);
    }
  });

  it("makes the OPTIONAL properties discoverable — the one thing no refusal can ever surface", async () => {
    // THE CLAUSE THE TICKET'S PREMISE RESTS ON. A closed-object validator
    // reports only the key that WAS sent, and `required` names only what is
    // mandatory, so a property that is declared-but-optional appears in no
    // refusal at any input. If this tool does not surface it, nothing in this
    // toolset does — which is the falsifiable half of "the contract is
    // readable now".
    const result = await answer(SERVED_DOCUMENT);
    const served = result.structured ?? {};

    const optional = optionalPropertiesOf(served);
    assert.ok(
      optional.length > 0,
      "the fixture declares no optional property, so this check would verify nothing",
    );

    for (const name of optional) {
      // Discoverable in the shape an agent reads a contract from…
      assert.ok(
        name in propertiesOf(served),
        `${name} is declared but unreachable in the answer's property map`,
      );
      // …and in the bytes, which is the view a text-only client sees.
      assert.ok(result.text.includes(name), `${name} is absent from the served text`);
    }
  });

  it("serves whatever the mirror serves — the checks above are about the tool, not about one document", async () => {
    // The derivation's own guard. An implementation that recognised the real
    // document, or answered from a vendored copy of it, would satisfy every
    // assertion above and fail here.
    const result = await answer(OTHER_DOCUMENT);
    const served = result.structured ?? {};

    assert.equal(result.text, OTHER_DOCUMENT);
    assert.deepEqual(served, JSON.parse(OTHER_DOCUMENT));
    assert.ok(requiredOf(served).length > 0);
    assert.ok(enumeratedPropertiesOf(served).length > 0);
    assert.ok(optionalPropertiesOf(served).length > 0);
    for (const name of optionalPropertiesOf(served)) {
      assert.ok(name in propertiesOf(served));
    }
  });

  it("diagnoses an unparseable 2xx body as a malformed mirror, NOT as a misconfigured endpoint", async () => {
    // The transport's shared not-JSON sentence tells the operator to check that
    // the endpoint points at a SpecGuard deployment "and not, say, a proxy or
    // login page". A 200 on this path is evidence AGAINST that reading: the
    // route was reached and answered. Reusing it would send the operator to fix
    // the one thing the response proves is right.
    const error = await rejects(answer("<html><body>hello</body></html>"), /not valid JSON/);

    assert.doesNotMatch(error.message, /proxy or login page/);
    assert.doesNotMatch(error.message, /SPECGUARD_ENDPOINT|SPECGUARD_URL/);
    assert.match(error.message, /schemas\/open-test-intent\.v1\.json/);
    assert.match(error.message, /deployment rather than a configuration problem/);
  });

  it("refuses a 2xx JSON body whose root is not an object, naming the same cause", async () => {
    // A schema document's root is an object, and `ToolResult.structured` is a
    // record — so an array or a bare scalar is malformed in exactly the way the
    // sentence above describes, and gets that sentence rather than the
    // transport's endpoint hint.
    const error = await rejects(answer("[]"), /not a JSON object/);

    assert.doesNotMatch(error.message, /proxy or login page/);
    assert.match(error.message, /schemas\/open-test-intent\.v1\.json/);
  });

  it("renders describeFailure's canned 404 hint for a deployment that predates the route", async () => {
    // An older deployment answers 404 with whatever its framework renders — a
    // non-contract body naming no cause — so the canned endpoint hint fires.
    // The description pre-empts the wrong reading of exactly this error
    // (endpoint right, build old), which is why the hint's wording is pinned
    // here rather than left incidental.
    const error = await rejects(
      getIntentSchema.run(
        {},
        toolContext({
          env: ENDPOINT_ONLY_ENV,
          fetch: stubFetch({ status: 404, body: "<html><body>Not Found</body></html>" }).fetch,
        }),
      ),
      /has no such endpoint \(404\)/,
    );

    assert.match(error.message, /SPECGUARD_ENDPOINT/);
    // Never a key variable: this ask presents no credential, so a 404 here can
    // never be a key problem.
    assert.doesNotMatch(
      error.message,
      /SPECGUARD_API_KEY|SPECGUARD_USER_API_KEY|SPECGUARD_AGENT_API_KEY/,
    );
  });

  it("hands a non-2xx body to the shared diagnosis rather than re-deriving one", async () => {
    // The failure hand-off is INHERITED: the raw-body read differs from the
    // JSON read in what it does with a SUCCESS, and in nothing else.
    await rejects(
      getIntentSchema.run(
        {},
        toolContext({
          env: ENDPOINT_ONLY_ENV,
          fetch: stubFetch({ status: 503, body: "upstream down" }).fetch,
        }),
      ),
      /SpecGuard answered 503.*upstream down/s,
    );
  });

  it("names the reference/judge split, the optional-property gap and the byte-equal text in its description", async () => {
    // The description is the artifact an agent acts on: the facts that would
    // otherwise be discovered through a wrong call are asserted rather than
    // trusted to review. It names no field of the contract — a prose copy would
    // be one release behind the document the tool serves.
    const description = getIntentSchema.description;

    assert.match(description, /lint_intent_annotations is the judge/);
    assert.match(description, /OPTIONAL property can never appear in any refusal/);
    assert.match(description, /`text` is the served bytes UNCHANGED/);
    assert.match(description, /PREDATES the mirror route/);
    assert.match(description, /the endpoint is right and the build is old/);
    assert.match(description, /NO API key/);
    assert.match(description, /no Authorization header/);
  });
});

/**
 * The config seam, in the direction this tool cares about — the same shape
 * `get_server_version` pins, named in THIS file so a refactor re-attaching a
 * credential requirement to the second credential-free tool fails here rather
 * than at the deployment.
 */
describe("get_intent_schema config seam", () => {
  it("serves an environment with an endpoint and no keys", async () => {
    const http = stubFetch({ body: SERVED_DOCUMENT });

    await getIntentSchema.run({}, toolContext({ env: ENDPOINT_ONLY_ENV, fetch: http.fetch }));

    assert.equal(http.requests.length, 1);
  });

  it("names ONLY the endpoint variable when nothing is set — never a key variable", async () => {
    const http = stubFetch({ body: SERVED_DOCUMENT });

    const error = await rejects(
      getIntentSchema.run({}, toolContext({ env: {}, fetch: http.fetch })),
      /SPECGUARD_ENDPOINT is not set/,
    );

    assert.match(error.message, /needs no API key/);
    assert.doesNotMatch(
      error.message,
      /SPECGUARD_API_KEY|SPECGUARD_USER_API_KEY|SPECGUARD_AGENT_API_KEY/,
    );
    assert.equal(http.requests.length, 0, "no request should be made without the endpoint");
  });
});

/**
 * THE DEADLINE, AT TOOL LEVEL.
 *
 * The transport tests prove the shared request is bounded; this proves the TOOL
 * routes through it. A tool that reached for `globalThis.fetch` directly, or
 * grew a client of its own for the raw-body read, would pass every other test
 * in this file.
 */
describe("get_intent_schema is bounded by SPECGUARD_TIMEOUT_MS", () => {
  let socket: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    socket = setInterval(() => {}, 1_000);
  });

  afterEach(() => {
    clearInterval(socket);
  });

  it("gives up on a body that never arrives", { timeout: 5_000 }, async () => {
    // Headers at once, body never — the shape a raw-body read is most exposed
    // to, since the whole answer IS the body.
    const http = stubSlowFetch("never");

    const error = await rejects(
      getIntentSchema.run(
        {},
        toolContext({
          env: { ...ENDPOINT_ONLY_ENV, SPECGUARD_TIMEOUT_MS: "50" },
          fetch: http.fetch,
        }),
      ),
      /https:\/\/sg\.example\.com did not respond within 50ms/,
    );

    // A stall is not an unreachable deployment: it was reached, and stopped.
    assert.doesNotMatch(error.message, /Could not reach/);
    assert.equal(http.requests.length, 1);
  });
});
