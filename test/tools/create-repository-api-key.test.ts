import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import createRepositoryApiKey from "../../src/tools/create-repository-api-key.js";
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

/**
 * The 201 body `user_repository_api_keys_controller#create` serves:
 * `{api_key: {name, token, hint, created_at}}`, where `token` is
 * `api_key.raw_token` — the only time this value exists anywhere.
 */
const BODY = JSON.stringify({
  api_key: {
    name: "ci",
    token: "sgk_reveal_once",
    hint: "sgk_re…",
    created_at: "2026-08-28T12:00:00Z",
  },
});

describe("create_repository_api_key", () => {
  it("issues a POST with a TOP-LEVEL name, not nested under api_key", async () => {
    // `RecordedRequest` carries method AND body: this fails if the call sends
    // a GET, sends nothing, or nests the parameters under a key the
    // controller does not permit.
    const http = stubFetch({ status: 201, body: BODY });

    await createRepositoryApiKey.run(
      { repository_id: "42", name: "ci" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/api_keys");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), { name: "ci" });
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("omits name from the wire entirely when not given, so the server's default applies", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    await createRepositoryApiKey.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.deepEqual(JSON.parse(http.requests[0]?.body ?? "null"), {});
  });

  it("returns the 201 body UNRESHAPED, reveal-once token intact", async () => {
    const result = await createRepositoryApiKey.run(
      { repository_id: "42", name: "ci" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 201, body: BODY }).fetch }),
    );

    // `deepEqual` against the parsed fixture, not a hand-listed subset: the
    // token exists nowhere else, so any reshaping on this hop is a value that
    // cannot be recovered rather than a field that can be re-fetched.
    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.equal(
      ((result.structured as Record<string, unknown>)["api_key"] as Record<string, unknown>)["token"],
      "sgk_reveal_once",
    );
    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    await rejects(
      createRepositoryApiKey.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      createRepositoryApiKey.run(
        { repository_id: "42" },
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
      createRepositoryApiKey.run(
        { repository_id: "42" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "nope" }).fetch,
        }),
      ),
      /SpecGuard answered 403: nope/,
    );
  });

  it("keeps the 404 branch", async () => {
    await rejects(
      createRepositoryApiKey.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The api-keys endpoints answer BOTH key kinds since SPGD-973 (`dee29bf`) — the
    // mint is then bounded by the key's own set and its `keys.manage` — so an
    // agent holding only the agent credential can mint a CI key. Nothing on the
    // wire changes beyond the Bearer: same POST, same shape.
    const http = stubFetch({ status: 201, body: BODY });

    await createRepositoryApiKey.run(
      { repository_id: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/api_keys");
    assert.equal(request?.headers["authorization"], "Bearer sga_test");
  });

  it("prefers the agent key when BOTH credentials are set", async () => {
    // Scope consistency, not preference: the agent set is what
    // `list_repositories` reports and what the other agent-keyed tools answer
    // inside, so an answer from the person's wider set could name something
    // the agent's own discovery never showed. Asserted ONCE per tool — the
    // precedence is the helper's (`config.ts`), not this tool's behavior to
    // re-prove.
    const http = stubFetch({ status: 201, body: BODY });

    await createRepositoryApiKey.run(
      { repository_id: "42" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("names BOTH variables when only the repository key is set", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    const error = await rejects(
      createRepositoryApiKey.run(
        { repository_id: "42" },
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
 * `name` argument description and the README section. The wire tests above pin
 * requests, the unreshaped 201 body, the 403/404 rendering and credential
 * precedence — but no operative clause an agent must hold BEFORE it acts on the
 * minted token is asserted anywhere: the mint returns the new key ALONE (the
 * full set is the listing's answer), the reveal-once token and its
 * hand-to-the-user rule, the mint-then-revoke recovery with no regenerate, the
 * two-part id source, minting does not disturb existing keys, `keys_manage` +
 * the 403 refusal, the either-credential rule with its agent-side 404 bound and
 * `attributed_user` attribution, and the `sgk_`-credential contrast. A
 * clause-level edit to any of them leaves the suite green, so these pin each
 * clause family on its own surface — the description examples below assert the
 * served `description:`, the README examples assert the section's copy —
 * because the README states them independently and `readme.test.ts` checks
 * identifier presence only (any REWORDING that keeps the backticked names stays
 * green there). The one mutation that IS caught today is a pure identifier
 * rename (`attributed_user` → anything else), which the response-keys sync
 * guard in `readme.test.ts` rejects; a semantic rewording that keeps the
 * identifier passes, which is exactly the gap these examples close.
 *
 * The README section is sliced from its heading to the next `### `; `**`
 * emphasis and `>` blockquote markers are dropped and whitespace collapsed (the
 * README wraps lines mid-sentence and sets the reveal-once warning as a
 * blockquote) so assertions are line-wrap-proof.
 */
describe("create_repository_api_key — the operative prose it teaches", () => {
  const HEADING = "### `create_repository_api_key`";
  const collapse = (text: string): string =>
    text.replace(/\*\*/g, "").replace(/^>\s?/gm, " ").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(createRepositoryApiKey.description);
  const nameArg = collapse(
    (createRepositoryApiKey.inputSchema.properties as Record<
      string,
      { description?: string } | undefined
    >)["name"]?.description ?? "",
  );

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 2000, "the README section is suspiciously short");
  });

  // -- The description's clause families --------------------------------------

  it("description: the mint returns the new key ALONE — the full key set is list_repository_api_keys' answer, never this response's", () => {
    assert.match(d, /returning the new key ALONE in an `api_key` block/);
    assert.match(
      d,
      /the repository's full key set \(keys minted in the web panel or in an earlier session included\) is `list_repository_api_keys`' answer, never this response's/,
    );
  });

  it("description: the token is shown THIS ONCE AND NEVER AGAIN — nothing stores it, so hand it to the user in your reply", () => {
    assert.match(
      d,
      /`api_key\.token` is shown THIS ONCE AND NEVER AGAIN — nothing stores it and no endpoint can re-serve it/,
    );
    assert.match(d, /hand it to the user in your reply rather than assuming it can be fetched later/);
  });

  it("description: a dropped token is recovered by minting another key with this same tool (no regenerate), THEN revoking the orphaned one", () => {
    assert.match(
      d,
      /the recovery is minting another key with this same tool \(the platform has no regenerate\), then revoking the orphaned one/,
    );
  });

  it("description: the minted id is the key's durable handle; every OTHER key's id comes from list_repository_api_keys", () => {
    assert.match(d, /`id` is the key's durable handle \(the token is reveal-once\)/);
    assert.match(d, /every OTHER key's id comes from `list_repository_api_keys`/);
  });

  it("description: minting does not disturb existing keys — each key authenticates independently until revoked", () => {
    assert.match(
      d,
      /Minting does not disturb existing keys: each key on a repository authenticates independently until revoked/,
    );
  });

  it("description: authorization is the keys_manage capability and a member without it is refused 403 in SpecGuard's own words", () => {
    assert.match(
      d,
      /Authorization is the `keys_manage` capability — a member without it is refused 403 in SpecGuard's own words/,
    );
  });

  it("description: the EITHER-credentials rule — the agent key is bounded by its keys.manage grants (404, never a probe), the user key is add_repository's", () => {
    assert.match(d, /It authenticates with EITHER of this server's two key-administration credentials/);
    assert.match(
      d,
      /only where the grant carries `keys\.manage`; a repository outside that set answers 404 in SpecGuard's own words, never a probe here/,
    );
    assert.match(d, /SPECGUARD_USER_API_KEY \(an sgu_… key, the same credential `add_repository` writes with\)/);
  });

  it("description: with both credentials set the agent key wins, so the mint answers inside the same set list_repositories reports", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the mint answers inside the same set `list_repositories` reports/,
    );
  });

  it("description: minting under the agent credential attributes the key to the key's OWNER (the attributed_user rule)", () => {
    assert.match(
      d,
      /Minting under the agent credential attributes the new key to the agent key's OWNER \(the server's `attributed_user` rule\), so minted-key counts keep naming a person rather than nobody/,
    );
  });

  it("description: a DIFFERENT credential from the sgk_ repository key get_repository_overview uses, refused in the other's place", () => {
    assert.match(
      d,
      /a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses; SpecGuard refuses each in the other's place/,
    );
  });

  it("name argument: optional, omitted means the server's default name applies (description, argument description, README row)", () => {
    assert.match(d, /an optional `name`, which the server defaults when omitted/);
    assert.match(nameArg, /An optional label for the key\. Omit it to let SpecGuard use its default name\./);
    assert.match(
      section,
      /\| `name` \| an optional label for the key; omit it to let SpecGuard use its default name \|/,
    );
  });

  // -- The README section's copy ----------------------------------------------

  it("README: the mint returns the new key alone, and minting does not disturb existing keys", () => {
    assert.match(section, /returning the new key alone in an `api_key` block/);
    assert.match(
      section,
      /Minting does not disturb existing keys — each key on a repository authenticates independently until revoked/,
    );
  });

  it("README: the token is shown once and never again, and the recovery names mint-then-revoke with revoke_repository_api_key", () => {
    assert.match(
      section,
      /`api_key\.token` is shown once and never again\. Nothing stores it and no endpoint can re-serve it/,
    );
    assert.match(section, /Hand it to the person you are working for in your reply/);
    assert.match(
      section,
      /the recovery is minting another key with this same tool — the platform has no regenerate — then revoking the orphaned one with `revoke_repository_api_key`/,
    );
  });

  it("README: the id source rule and the keys_manage 403 authorization, verbatim", () => {
    assert.match(section, /`id` is the key's durable handle \(the token is reveal-once\); every other key's id comes from `list_repository_api_keys`/);
    assert.match(
      section,
      /Authorization is the `keys_manage` capability; a member without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
  });

  it("README: the credential pair, the agent-wins precedence and the attributed-to-owner tail", () => {
    assert.match(section, /a different one from the `sgk_…` key `get_repository_overview` uses/);
    assert.match(
      section,
      /the same person key `add_repository` reads\. With both set the agent key wins, so the mint answers inside the same set `list_repositories` reports/,
    );
    assert.match(
      section,
      /attributes the new key to the agent key's owner \(the server's `attributed_user` rule\), so minted-key counts keep naming a person rather than nobody/,
    );
  });
});
