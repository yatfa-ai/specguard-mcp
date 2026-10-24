import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import revokeRepositoryAgentKey from "../../src/tools/revoke-repository-agent-key.js";
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
 * The 200 DISCLOSURE body `user_repository_agent_keys_controller#destroy`
 * serves — the API's substitute for the web confirm dialog: count first, then
 * the still-existing names, plus `deleted_repository_count` only when
 * positive. This fixture carries it positive, because a reshape that dropped
 * exactly that field is the defect the pass-through pin exists to catch.
 */
const BODY = JSON.stringify({
  agent_key: {
    id: 9,
    name: "automation",
    revoked_at: "2026-09-11T12:00:00Z",
    repository_count: 3,
    repositories: ["acme/alpha", "acme/beta"],
    deleted_repository_count: 1,
  },
});

/** The same body without the deleted-repositories clause — the common case. */
const BODY_NO_DELETIONS = JSON.stringify({
  agent_key: {
    id: 9,
    name: "automation",
    revoked_at: "2026-09-11T12:00:00Z",
    repository_count: 1,
    repositories: ["acme/alpha"],
  },
});

describe("revoke_repository_agent_key", () => {
  it("issues a DELETE scoped to the repository, with no body", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys/9");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("answers 200 WITH the disclosure body, parsed — not the sgk_ sibling's raw-204 handling", async () => {
    // The body IS the confirmation (the substitute for the web confirm
    // dialog), so the route through `requestJson`'s parse must land it in
    // `structured` whole: this fails if the call went through `deleteJson`'s
    // raw-text path and the tool never parsed the disclosure.
    const result = await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
    const agentKey = (result.structured as Record<string, unknown>)["agent_key"] as Record<
      string,
      unknown
    >;
    assert.equal(agentKey["revoked_at"], "2026-09-11T12:00:00Z");
    assert.equal(agentKey["deleted_repository_count"], 1);
  });

  it("passes the disclosure body through UNRESHAPED — deleted_repository_count included", async () => {
    const result = await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("passes the common disclosure through too — no deleted-repositories clause when none deleted", async () => {
    const result = await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({
        env: USER_ENV,
        fetch: stubFetch({ status: 200, body: BODY_NO_DELETIONS }).fetch,
      }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY_NO_DELETIONS));
    const agentKey = (result.structured as Record<string, unknown>)["agent_key"] as Record<
      string,
      unknown
    >;
    assert.equal("deleted_repository_count" in agentKey, false);
  });

  it("refuses a missing key_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`key_id` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a revoke");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "9" },
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
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "9" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 404 branch — the live.find_by/covers? fork's own answer for a foreign or replayed id", async () => {
    // A key id that is already revoked, or whose stored set does not cover
    // THIS repository, is a 404 server-side — never a cross-repository cut.
    // The branch here is the deployment's; the bridge adds no check of its own.
    await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "999" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The agent-keys endpoints answer BOTH key kinds since SPGD-1004 (`dfb9892`) —
    // the cut is then bounded by the key's own set and its `keys.manage` — so an
    // agent credential can revoke one of its own kind, completing the offboarding
    // arc without a person's `sgu_` key. Nothing on the wire changes beyond the
    // Bearer: same DELETE, same path, same 200-with-disclosure.
    const http = stubFetch({ status: 200, body: BODY });

    await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys/9");
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
    const http = stubFetch({ status: 200, body: BODY });

    await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("names BOTH variables when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "9" },
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
 * The tool's whole agent-facing safety contract is prose: the `description`, the
 * `repository_id`/`key_id` argument descriptions and the README section. The wire
 * tests above pin requests, the 200-with-disclosure pass-through, the 403/404
 * rendering and credential precedence — but no operative clause an agent must
 * hold BEFORE it commits the cut is asserted anywhere: the IRREVERSIBLE cut whose
 * blast radius is the key's WHOLE stored set, the `repository_count` check that
 * must happen BEFORE a multi-repository key is cut, the 200-with-body shape that
 * is deliberately NOT the sgk_ sibling's empty 204, the repository-scoped 404
 * (never a cross-repository cut), the list-first id source for a key with no
 * mint tool, `keys_manage` with its 403, and the EITHER-credential rule with the
 * agent set's own 404 bound. A clause-level edit to any of them leaves the suite
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
describe("revoke_repository_agent_key — the operative prose it teaches", () => {
  const HEADING = "### `revoke_repository_agent_key`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(revokeRepositoryAgentKey.description);
  const argDescription = (name: string): string =>
    collapse(
      (revokeRepositoryAgentKey.inputSchema.properties as Record<
        string,
        { description?: string } | undefined
      >)[name]?.description ?? "",
    );
  const repositoryIdArg = argDescription("repository_id");
  const keyIdArg = argDescription("key_id");

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 800, "the README section is suspiciously short");
  });

  // -- The description's clause families -------------------------------------

  it("description: IRREVERSIBLE, and the blast radius is the key's WHOLE stored set — the grant is stored once at mint time, so one call cuts the token on EVERY repository the key covers, not just repository_id", () => {
    assert.match(
      d,
      /IRREVERSIBLE, and the blast radius is the key's WHOLE stored set: the grant \(repository set \+ permission set\) is stored once at mint time, so this one call cuts the token on EVERY repository the key covers, not just `repository_id`/,
    );
  });

  it("description: check repository_count on list_repository_agent_keys BEFORE cutting a multi-repository key", () => {
    assert.match(
      d,
      /check `repository_count` on `list_repository_agent_keys` BEFORE cutting a multi-repository key/,
    );
  });

  it("description: answers 200 WITH the disclosure body — an agent_key block carrying revoked_at, repository_count and the still-existing repositories names, plus deleted_repository_count when some have been deleted since mint", () => {
    assert.match(
      d,
      /Answers `200` WITH the disclosure body — an `agent_key` block carrying `revoked_at`, `repository_count` and the still-existing `repositories` names, plus `deleted_repository_count` when some have been deleted since mint/,
    );
  });

  it("description: NOT the empty 204 the sgk_ sibling revoke_repository_api_key serves — the body itself is the confirmation", () => {
    assert.match(
      d,
      /NOT the empty 204 the sgk_ sibling `revoke_repository_api_key` serves; the body itself is the confirmation/,
    );
  });

  it("description: the key_id is scoped to repository_id — a key whose stored set does not cover this repository, or one already revoked, is refused 404, never a cross-repository cut", () => {
    assert.match(
      d,
      /The `key_id` is scoped to `repository_id`: a key whose stored set does not cover this repository, or one already revoked, is refused 404, never a cross-repository cut/,
    );
  });

  it("description: agent keys have NO mint tool on this bridge, so take key_id from list_repository_agent_keys — list first, then revoke", () => {
    assert.match(
      d,
      /Agent keys have NO mint tool on this bridge \(minting is deliberately web-only\), so take `key_id` from `list_repository_agent_keys` — list first, then revoke/,
    );
  });

  it("description: authorization is the keys_manage capability — a caller without it is refused 403 in SpecGuard's own words", () => {
    assert.match(
      d,
      /Authorization is the `keys_manage` capability — a caller without it is refused 403 in SpecGuard's own words/,
    );
  });

  it("description: the EITHER-credential rule — SPECGUARD_AGENT_API_KEY when set, SPECGUARD_USER_API_KEY when that is not set", () => {
    assert.match(
      d,
      /It authenticates with EITHER of this server's two key-administration credentials, whichever is set: SPECGUARD_AGENT_API_KEY/,
    );
    assert.match(
      d,
      /and, when that is not set, SPECGUARD_USER_API_KEY \(an sgu_… key, the same credential the other key-administration tools read\)/,
    );
  });

  it("description: a repository outside the agent set answers 404, never a probe here — an agent credential revoking one of its own kind needs no person's sgu_ key", () => {
    assert.match(
      d,
      /a repository outside that set answers 404 in SpecGuard's own words, never a probe here — an agent credential revoking one of its own kind needs no person's `sgu_` key to do it/,
    );
  });

  it("description: with both set the agent key wins, so the cut answers inside the same set list_repositories reports", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the cut answers inside the same set `list_repositories` reports/,
    );
  });

  it("description: a DIFFERENT credential from the sgk_… repository key get_repository_overview uses; SpecGuard refuses each in the other's place", () => {
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses; SpecGuard refuses each in the other's place/,
    );
  });

  // -- The argument descriptions ---------------------------------------------

  it("repository_id argument: the numeric id from add_repository / list_repositories, not the org/repo handle — and the CUT lands on every repository in the key's stored set", () => {
    assert.match(
      repositoryIdArg,
      /The repository whose key-administration scope the call is made under — its numeric id, as `add_repository` returns and `list_repositories` reports, not the `org\/repo` handle/,
    );
    assert.match(repositoryIdArg, /The CUT, however, lands on every repository in the key's stored set/);
  });

  it("key_id argument: served by list_repository_agent_keys — the only id source, because agent keys have no mint tool on this bridge — and scoped to repository_id, refused 404", () => {
    assert.match(
      keyIdArg,
      /The id of the agent key to revoke, as served by `list_repository_agent_keys` — the only id source, because agent keys have no mint tool on this bridge/,
    );
    assert.match(
      keyIdArg,
      /Scoped to `repository_id`: a key whose stored set excludes this repository, or one already revoked, is refused 404/,
    );
  });

  // -- The README section's copy ----------------------------------------------

  it("README: Irreversible, and the blast radius is the key's whole stored set — the grant is stored once at mint time, so one call cuts the token on EVERY repository the key covers, not just repository_id", () => {
    assert.match(
      section,
      /Irreversible, and the blast radius is the key's whole stored set: an agent key's grant \(repository set \+ permission set\) is stored once at mint time, so this one call cuts the token on EVERY repository the key covers, not just `repository_id`/,
    );
  });

  it("README: check repository_count on list_repository_agent_keys before cutting, and the only id source — agent keys have no mint tool on this bridge", () => {
    assert.match(
      section,
      /Check `repository_count` on `list_repository_agent_keys` before cutting a multi-repository key/,
    );
    assert.match(
      section,
      /the only id source, because agent keys have no mint tool on this bridge/,
    );
  });

  it("README: answers 200 with the disclosure body, not the empty 204 the sgk_ sibling serves — the API's substitute for the web confirm dialog, so the body itself is the confirmation", () => {
    assert.match(
      section,
      /This endpoint answers `200` with the disclosure body, not the empty `204` the sgk_ sibling `revoke_repository_api_key` serves/,
    );
    assert.match(
      section,
      /the API's substitute for the web confirm dialog, so the body itself is the confirmation/,
    );
  });

  it("README: the key_id scoped 404 (never a cross-repository cut) and the keys_manage 403 authorization", () => {
    assert.match(
      section,
      /The `key_id` is scoped to `repository_id`: a key whose stored set does not cover this repository, or one already revoked, is refused `404`, never a cross-repository cut/,
    );
    assert.match(
      section,
      /Authorization is the `keys_manage` capability; a caller without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
  });

  it("README: the both-set winner — the agent key wins, the cut answers inside the same set list_repositories reports — and the sgk_… credential contrast", () => {
    assert.match(
      section,
      /With both set the agent key wins, so the cut answers inside the same set `list_repositories` reports/,
    );
    assert.match(
      section,
      /a different one from the `sgk_…` key `get_repository_overview` uses/,
    );
  });
});
