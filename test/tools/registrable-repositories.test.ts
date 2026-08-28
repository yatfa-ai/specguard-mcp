import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registrableRepositories from "../../src/tools/registrable-repositories.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the environment an operator who wants just this tool has. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** Only the REPOSITORY key — refused by design before any table is read. */
const REPOSITORY_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_API_KEY: "sgk_test",
};

/**
 * The body `Api::V1::UserRepositoriesController#registrable` serves, shaped as
 * that controller renders it: `repositories` (each entry `full_name` and
 * `registered`, globally asked) and the derived `grant` block.
 *
 * The fixture carries BOTH values of `registered` — an all-`false` fixture would
 * let a bridge that dropped or defaulted the flag still pass, and the flag is
 * the whole point of this surface: `registered: true` is the answer to "why did
 * my POST say has already been taken", including for a repository somebody ELSE
 * registered.
 */
const BODY = JSON.stringify({
  repositories: [
    { full_name: "acme/app", registered: true },
    { full_name: "acme/billing", registered: false },
  ],
  grant: { captured_at: "2026-08-20T10:00:00Z", expires_at: "2026-08-27T10:00:00Z", stale: false },
});

describe("registrable_repositories", () => {
  it("asks the registrable endpoint, with the user key and no arguments on the wire", async () => {
    const http = stubFetch({ body: BODY });

    await registrableRepositories.run({}, toolContext({ env: USER_ENV, fetch: http.fetch }));

    const request = http.requests[0];
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/registrable");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("passes the deployment's body back unmodified, repositories and grant alike", async () => {
    // `deepEqual` against the PARSED fixture rather than a hand-listed subset:
    // this bridge is a thin client, so a field added upstream must reach the
    // agent without a release here, and any reshaping — recomputing `stale`,
    // re-deriving `expires_at`, dropping `grant` — has to fail rather than be
    // reported as a nicer answer. Client-side re-derivation of staleness is a
    // second, drifting copy of `MAX_AGE`, and the ticket forbids it.
    const result = await registrableRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));

    const entry = (result.structured?.["repositories"] as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(entry ?? {}).sort(), ["full_name", "registered"]);
    assert.deepEqual(Object.keys(result.structured?.["grant"] as object).sort(), [
      "captured_at",
      "expires_at",
      "stale",
    ]);
  });

  it("renders the same object it returns, so the two cannot disagree", async () => {
    const result = await registrableRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("refuses a JSON body that is not an object", async () => {
    await rejects(
      registrableRepositories.run(
        {},
        toolContext({ env: USER_ENV, fetch: stubFetch({ body: "[]" }).fetch }),
      ),
      /not an object/,
    );
  });
});

/**
 * The credential seam, in the direction this tool cares about: `registrable`
 * reads the `sgu_` key, and the `sgk_` repository key is refused 401 by design
 * before any table is read. Named in THIS file so a future refactor collapsing
 * the two slots back into one fails here rather than at the deployment.
 */
describe("registrable_repositories reads the user credential", () => {
  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ body: BODY });

    const error = await rejects(
      registrableRepositories.run({}, toolContext({ env: REPOSITORY_ENV, fetch: http.fetch })),
      /SPECGUARD_USER_API_KEY is not set/,
    );

    assert.match(error.message, /sgu_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });

  it("reports both missing halves in one sentence rather than one per round trip", async () => {
    const error = await rejects(
      registrableRepositories.run({}, toolContext({ env: {} })),
      /SPECGUARD_ENDPOINT and SPECGUARD_USER_API_KEY are not set/,
    );
  });
});
