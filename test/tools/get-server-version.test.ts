import assert from "node:assert/strict";
import { describe, it } from "node:test";
import getServerVersion from "../../src/tools/get-server-version.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/**
 * The environment this tool exists for: an endpoint and NO keys. Every other
 * HTTP-backed tool here would refuse this environment with a ConfigError; the
 * whole point of SPGD-1200 is that this one serves it — the route is
 * unauthenticated by design, so demanding a key would invent a requirement the
 * deployment does not have.
 */
const ENDPOINT_ONLY_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
};

/**
 * The body `VersionsController#show` serves, shaped as that controller renders
 * it: one key, `version`, read from the memoized VERSION file. The null arm is
 * the controller's deliberate honest answer for a missing or unreadable file —
 * still 200 — and both arms are fixtures below, because a bridge that dropped
 * or defaulted either must fail.
 */
const BODY = JSON.stringify({ version: "0.1.46" });
const NULL_BODY = JSON.stringify({ version: null });

describe("get_server_version", () => {
  it("asks the root-level version endpoint with a GET and NO Authorization header, from a keys-free environment", async () => {
    const http = stubFetch({ body: BODY });

    await getServerVersion.run({}, toolContext({ env: ENDPOINT_ONLY_ENV, fetch: http.fetch }));

    const request = http.requests[0];
    // Root-level: NOT under /api/v1 — the route sits beside /up on purpose.
    assert.equal(request?.url, "https://sg.example.com/version");
    assert.equal(request?.method, "GET");
    // The credential-free ask presents nothing — never `Bearer ` with nothing
    // after it, the present-but-empty value `presence()` refuses on the way in.
    assert.equal(request?.headers["authorization"], undefined);
    assert.ok(!("authorization" in (request?.headers ?? {})), "no Authorization header at all");
  });

  it("still sends no Authorization header when every key variable IS set — the tool never borrows a credential", async () => {
    // The seam runs the other way from every sibling: credentialled tools read
    // whichever key they need; this one binds none even when all three sit in
    // the environment, because presenting a key the endpoint does not read is
    // not authentication, it is leakage.
    const http = stubFetch({ body: BODY });

    await getServerVersion.run(
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
  });

  it("passes the deployment's version through verbatim", async () => {
    // `deepEqual` against the PARSED fixture rather than a hand-listed subset:
    // this bridge is a thin client, so any reshaping — renaming `version`,
    // defaulting null, nesting the answer — has to fail rather than be
    // reported as a nicer answer.
    const result = await getServerVersion.run(
      {},
      toolContext({ env: ENDPOINT_ONLY_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.deepEqual(Object.keys(result.structured ?? {}).sort(), ["version"]);
  });

  it("passes the null arm through as null, without error", async () => {
    // The controller serves `{"version": null}` with a 200 when its VERSION
    // file was missing or unreadable at boot — an unverifiable identity beats
    // a 500 from the one endpoint whose whole job is to be askable. The
    // bridge's job is to hand that honesty through: null, never a guessed
    // value, never an error.
    const result = await getServerVersion.run(
      {},
      toolContext({ env: ENDPOINT_ONLY_ENV, fetch: stubFetch({ body: NULL_BODY }).fetch }),
    );

    assert.deepEqual(result.structured, { version: null });
  });

  it("renders the same object it returns, so the two cannot disagree", async () => {
    const result = await getServerVersion.run(
      {},
      toolContext({ env: ENDPOINT_ONLY_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("refuses a JSON body that is not an object", async () => {
    await rejects(
      getServerVersion.run(
        {},
        toolContext({ env: ENDPOINT_ONLY_ENV, fetch: stubFetch({ body: "[]" }).fetch }),
      ),
      /not an object/,
    );
  });

  it("renders describeFailure's canned 404 hint for a deployment that predates the route", async () => {
    // An old deployment answers 404 with whatever its framework renders — a
    // non-contract body that names no cause — so the canned endpoint hint
    // fires. The description pre-empts the wrong reading of exactly this
    // error (endpoint right, build old), which is why the hint's wording is
    // pinned here rather than left incidental.
    const error = await rejects(
      getServerVersion.run(
        {},
        toolContext({
          env: ENDPOINT_ONLY_ENV,
          fetch: stubFetch({ status: 404, body: "<html><body>Not Found</body></html>" }).fetch,
        }),
      ),
      /has no such endpoint \(404\)/,
    );

    assert.match(error.message, /SPECGUARD_ENDPOINT/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY|SPECGUARD_USER_API_KEY|SPECGUARD_AGENT_API_KEY/);
  });

  it("names the deployment/bridge distinction, the null arm and the 404 arm in its description", async () => {
    // The description is the artifact an agent acts on (see
    // `list-repositories.test.ts` for the instrument): all four facts that
    // would otherwise be discovered through a wrong call are asserted rather
    // than trusted to review.
    const description = getServerVersion.description;

    // It answers the DEPLOYMENT's build.
    assert.match(description, /WHICH BUILD of the SpecGuard DEPLOYMENT/);
    // …and says how that differs from the bridge's own identity, by name.
    assert.match(description, /`serverInfo`/);
    assert.match(description, /User-Agent/);
    assert.match(description, /different component/);
    // The null arm: honest, served, never faked.
    assert.match(description, /`version: null`/);
    assert.match(description, /never replaced with a guessed value/);
    // The 404 arm: endpoint right, build old — and the hint's wording named
    // so the error is read as an upgrade request, not a URL fix.
    assert.match(description, /PREDATES the route/);
    assert.match(description, /the endpoint is right and the build is old/);
    // The credential-free ask, by name.
    assert.match(description, /NO API key/);
    assert.match(description, /no `Authorization` header/);
  });
});

/**
 * The config seam, in the direction this tool cares about: an endpoint and NO
 * keys is a served environment, and the one refusal it can produce names ONLY
 * the endpoint variable — never a key variable, because this ask has none to
 * require. Named in THIS file so a future refactor re-attaching a credential
 * requirement fails here rather than at the deployment.
 */
describe("get_server_version config seam", () => {
  it("serves an environment with an endpoint and no keys — the new helper's whole point", async () => {
    const http = stubFetch({ body: BODY });

    await getServerVersion.run({}, toolContext({ env: ENDPOINT_ONLY_ENV, fetch: http.fetch }));

    assert.equal(http.requests.length, 1);
  });

  it("names ONLY the endpoint variable when nothing is set — never a key variable", async () => {
    const http = stubFetch({ body: BODY });

    const error = await rejects(
      getServerVersion.run({}, toolContext({ env: {}, fetch: http.fetch })),
      /SPECGUARD_ENDPOINT is not set/,
    );

    assert.match(error.message, /needs no API key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY/);
    assert.doesNotMatch(error.message, /SPECGUARD_USER_API_KEY/);
    assert.doesNotMatch(error.message, /SPECGUARD_AGENT_API_KEY/);
    assert.equal(http.requests.length, 0, "no request should be made without the endpoint");
  });

  it("speaks the operator's spelling — SPECGUARD_URL — when that is the variable set", async () => {
    const error = await rejects(
      getServerVersion.run(
        {},
        toolContext({ env: { SPECGUARD_URL: "sg.example.com" }, fetch: stubFetch({ body: BODY }).fetch }),
      ),
      /SPECGUARD_URL is not a usable URL/,
    );

    // The parse is inherited from the shared helper, not re-derived weaker —
    // the scheme-less host is refused by name, as it is for every other tool.
    assert.match(error.message, /must be your SpecGuard/);
  });
});
