import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import revokeRepositoryApiKey from "../../src/tools/revoke-repository-api-key.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** Only the AGENT key — the environment an agent-configured operator has. */
const AGENT_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_AGENT_API_KEY: "sga_test",
};

/** The `204` with NO body — the deployment's whole success answer. */
const NO_CONTENT = { status: 204, body: "" };

describe("revoke_repository_api_key", () => {
  it("issues a DELETE scoped to the repository, with no body", async () => {
    const http = stubFetch(NO_CONTENT);

    await revokeRepositoryApiKey.run(
      { repository_id: "42", key_id: "7" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/api_keys/7");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("succeeds on a 204 with an empty body, without parsing it as JSON", async () => {
    // Same trap as `remove_repository`: an empty-body 204 routed through
    // `requestJson` would be reported as a not-JSON failure, not a revoke.
    const result = await revokeRepositoryApiKey.run(
      { repository_id: "42", key_id: "7" },
      toolContext({ env: USER_ENV, fetch: stubFetch(NO_CONTENT).fetch }),
    );

    assert.notEqual(result.text, "");
    assert.deepEqual(result.structured, { repository_id: "42", key_id: "7", revoked: true });
  });

  it("refuses a missing key_id before anything is sent", async () => {
    const http = stubFetch(NO_CONTENT);

    await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`key_id` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a revoke");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    // A member without `keys_manage` — this and every other endpoint on the
    // surface answers them this way.
    await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "7" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 403,
            body: JSON.stringify({
              error: "not_granted",
              message: "You do not have permission to do that on this repository.",
            }),
          }).fetch,
        }),
      ),
      /SpecGuard refused the request \(403\): You do not have permission to do that on this repository\./,
    );
  });

  it("falls back to the generic sentence on a non-conforming 403 body", async () => {
    await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "7" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 404 branch — the scoping rule's own answer for a foreign key id", async () => {
    // A key id belonging to a DIFFERENT repository is a 404 server-side
    // (`repository.api_keys.find_by` + its crafted raise), never a
    // cross-repository delete. The branch here is the deployment's; the
    // bridge adds no check of its own.
    await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "999" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("surfaces the platform's own 404 sentence when the stale-or-foreign key id carries a body", async () => {
    // The stale-key story this tool itself prescribes (mint replacement →
    // deploy → revoke the orphan): a key id the repository no longer knows
    // raises `ActiveRecord::RecordNotFound` into `render_not_found`, whose
    // body names the cause — the raise carries the controller's own crafted
    // sentence, and `Exception#as_json` is `to_s`, so that sentence (never a
    // class name) is what renders. That sentence must reach the tool
    // result; answering the canned endpoint-config hint here sends the reader
    // to debug SPECGUARD_ENDPOINT instead of re-checking WHICH key it named.
    await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "999" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 404,
            body: JSON.stringify({
              error: "not_found",
              message: "No API key with that id belongs to this repository.",
            }),
          }).fetch,
        }),
      ),
      /No API key with that id belongs to this repository\./,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The api-keys endpoints answer BOTH key kinds since SPGD-973 (`dee29bf`) — the
    // revoke is then bounded by the key's own set and its `keys.manage` — so an
    // agent holding only the agent credential can revoke a CI key it was granted
    // administration over. Nothing on the wire changes beyond the Bearer: same
    // DELETE, same path, same empty 204.
    const http = stubFetch(NO_CONTENT);

    await revokeRepositoryApiKey.run(
      { repository_id: "42", key_id: "7" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/api_keys/7");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sga_test");
  });

  it("prefers the agent key when BOTH credentials are set", async () => {
    // Scope consistency, not preference: the agent set is what
    // `list_repositories` reports and what the other agent-keyed tools answer
    // inside, so an answer from the person's wider set could name something
    // the agent's own discovery never showed. Asserted ONCE per tool — the
    // precedence is the helper's (`config.ts`), not this tool's behavior to
    // re-prove.
    const http = stubFetch(NO_CONTENT);

    await revokeRepositoryApiKey.run(
      { repository_id: "42", key_id: "7" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("names BOTH variables when only the repository key is set", async () => {
    const http = stubFetch(NO_CONTENT);

    const error = await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "7" },
        toolContext({
          env: { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" },
          fetch: http.fetch,
        }),
      ),
      /SPECGUARD_USER_API_KEY or SPECGUARD_AGENT_API_KEY is not set/,
    );

    // The one-message rule at double width: this tool accepts EITHER
    // credential, so refusing with a single name would send the operator to
    // fix a variable, re-call, and be told about the other. The prefixes ride
    // the same sentence — and no mention of the `sgk_` variable they DID set,
    // which is correct and is not the problem.
    assert.match(error.message, /sgu_… key/);
    assert.match(error.message, /sga_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY is not set/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });
});

/**
 * The tool's whole agent-facing contract is prose: the `description`, the
 * `key_id` argument description and the README section. The wire tests above pin
 * requests, the 204/403/404 rendering and credential precedence, and
 * `delete-204-text.test.ts` pins the runtime success sentence — but no operative
 * clause an agent must hold BEFORE it commits the cut is asserted anywhere: the
 * immediate cutoff and the surviving-key continuity, the never-cross-repository
 * 404 scoping, the mint-then-revoke ordering and its locked-out cost,
 * `keys_manage` with the 204 verdict, the two-part id source, the `sgk_`
 * credential contrast. A clause-level edit to any of them leaves the suite
 * green, so these pin each clause family on its own surface — the description
 * examples below assert the served `description:`, the README examples assert
 * the section's copy — because the README states them independently and
 * `readme.test.ts` checks identifier presence only (any REWORDING that keeps the
 * backticked names stays green there).
 *
 * The README section is sliced from its heading to the next `### `; `**` emphasis
 * is dropped and whitespace collapsed (the README wraps lines mid-sentence) so
 * assertions are line-wrap-proof.
 */
describe("revoke_repository_api_key — the operative prose it teaches", () => {
  const HEADING = "### `revoke_repository_api_key`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(revokeRepositoryApiKey.description);
  const keyIdArg = collapse(
    (revokeRepositoryApiKey.inputSchema.properties as Record<
      string,
      { description?: string } | undefined
    >)["key_id"]?.description ?? "",
  );

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 800, "the README section is suspiciously short");
  });

  // -- The description's clause families -------------------------------------

  it("description: the key stops authenticating immediately and every OTHER key keeps working, so CI keeps ingesting", () => {
    assert.match(
      d,
      /The key stops authenticating immediately; every OTHER key on the repository keeps working, so CI keeps ingesting if it holds a surviving key/,
    );
  });

  it("description: a key id belonging to a different repository is refused 404, never a cross-repository delete", () => {
    assert.match(
      d,
      /a key id belonging to a different repository is refused 404, never a cross-repository delete/,
    );
  });

  it("description: key rotation is mint-then-revoke, in that order, because the platform has no regenerate", () => {
    assert.match(d, /Key rotation is mint-then-revoke, in that order: the platform has no regenerate/);
  });

  it("description: mint the replacement and deploy it BEFORE revoking — revoke first and the repository's CI is locked out until a human mints a new key in a browser", () => {
    assert.match(
      d,
      /mint a replacement with `create_repository_api_key` and deploy it BEFORE revoking the old one/,
    );
    assert.match(
      d,
      /revoke first and the repository's CI is locked out until a human mints a new key in a browser/,
    );
  });

  it("description: authorization is the keys_manage capability (a member without it is refused 403) and a 204 means the key is revoked", () => {
    assert.match(
      d,
      /Authorization is the `keys_manage` capability — a member without it is refused 403 in SpecGuard's own words/,
    );
    assert.match(d, /A 204 means the key is revoked/);
  });

  it("description: the two-part id source — the mint response names the key IT minted, this listing names every other", () => {
    assert.match(d, /the mint response carries the id of the key IT minted in its `api_key` block/);
    assert.match(d, /every OTHER key's id comes from `list_repository_api_keys`/);
  });

  it("description: a DIFFERENT credential from the sgk_ repository key get_repository_overview uses, refused in the other's place", () => {
    assert.match(
      d,
      /a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses; SpecGuard refuses each in the other's place/,
    );
  });

  // -- The key_id argument description ---------------------------------------

  it("key_id argument: keys minted in the web panel or an earlier session have no other bridge-learnable id, and the id is scoped to the repository", () => {
    assert.match(
      keyIdArg,
      /keys minted in the web panel or in an earlier session have no other bridge-learnable id/,
    );
    assert.match(keyIdArg, /Scoped to `repository_id`: a foreign key id is refused 404/);
  });

  // -- The README section's copy ----------------------------------------------

  it("README: the key stops authenticating immediately; every other key keeps working, so CI keeps ingesting", () => {
    assert.match(
      section,
      /The key stops authenticating immediately; every other key on the repository keeps working, so CI keeps ingesting if it holds a surviving key/,
    );
  });

  it("README: the 404 scoping (never a cross-repository delete) and the keys_manage 403 authorization", () => {
    assert.match(
      section,
      /a key id belonging to a different repository is refused `404`, never a cross-repository delete/,
    );
    assert.match(
      section,
      /Authorization is the `keys_manage` capability; a member without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
  });

  it("README: rotation is mint-then-revoke in that order, deploy the replacement BEFORE revoking, and the revoke-first CI-locked-out cost with the 204 verdict", () => {
    assert.match(section, /Key rotation is mint-then-revoke, in that order\./);
    assert.match(
      section,
      /The platform has no regenerate, so mint a replacement with `create_repository_api_key` and deploy it BEFORE revoking the old one/,
    );
    assert.match(
      section,
      /revoke first and the repository's CI is locked out until a human mints a new key in a browser/,
    );
    assert.match(section, /A `204` means the key is revoked/);
  });

  it("README: a different credential from the sgk_ key get_repository_overview uses, and the agent-wins precedence tail scoped to list_repositories' set", () => {
    assert.match(section, /a different one from the `sgk_…` key `get_repository_overview` uses/);
    assert.match(
      section,
      /With both set the agent key wins, so the revoke answers inside the same set `list_repositories` reports/,
    );
  });
});
