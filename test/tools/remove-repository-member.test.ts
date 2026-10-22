import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import removeRepositoryMember from "../../src/tools/remove-repository-member.js";
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

describe("remove_repository_member", () => {
  it("issues a DELETE scoped to the repository and membership, with no body", async () => {
    const http = stubFetch(NO_CONTENT);

    await removeRepositoryMember.run(
      { repository_id: "42", member_id: "7" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members/7");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("succeeds on a 204 with an empty body, without parsing it as JSON", async () => {
    // Same trap as `remove_repository`: an empty-body 204 routed through
    // `requestJson` would be reported as a not-JSON failure, not a revoke.
    const result = await removeRepositoryMember.run(
      { repository_id: "42", member_id: "7" },
      toolContext({ env: USER_ENV, fetch: stubFetch(NO_CONTENT).fetch }),
    );

    assert.notEqual(result.text, "");
    // The keys asymmetry is restated at the moment of success — it is the last
    // moment the fact still matters.
    assert.match(result.text, /CI keys/);
    assert.deepEqual(result.structured, { repository_id: "42", member_id: "7", revoked: true });
  });

  it("refuses a missing member_id before anything is sent", async () => {
    const http = stubFetch(NO_CONTENT);

    await rejects(
      removeRepositoryMember.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`member_id` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a revoke");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    // A member without `members.manage`.
    await rejects(
      removeRepositoryMember.run(
        { repository_id: "42", member_id: "7" },
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
      removeRepositoryMember.run(
        { repository_id: "42", member_id: "7" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 404 branch — a foreign membership id AND a self-revoked caller's next call", async () => {
    // `find_membership!` scopes the id through the repository, so a foreign
    // membership id is a 404 — and a caller who revoked their OWN membership
    // is now a non-member, whose next request on these routes is a 404 too.
    await rejects(
      removeRepositoryMember.run(
        { repository_id: "42", member_id: "999" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("keeps the 401 branch — an sgk_ key is refused by accepts_user_credential", async () => {
    await rejects(
      removeRepositoryMember.run(
        { repository_id: "42", member_id: "7" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 401, body: "" }).fetch,
        }),
      ),
      /SpecGuard rejected the API key \(401\)/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The member WRITES answer BOTH key kinds since SPGD-973 (`dee29bf`) — the revoke
    // is then bounded by the key's own set and its `members.manage` — so an agent
    // holding only the agent credential can revoke a membership. Nothing on the
    // wire changes beyond the Bearer: same DELETE, same path, same empty 204.
    const http = stubFetch(NO_CONTENT);

    await removeRepositoryMember.run(
      { repository_id: "42", member_id: "7" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members/7");
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

    await removeRepositoryMember.run(
      { repository_id: "42", member_id: "7" },
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
      removeRepositoryMember.run(
        { repository_id: "42", member_id: "7" },
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
 * `remove_repository_member` is the DESTRUCTIVE member verb, and its operative
 * contract is prose an agent must hold BEFORE it commits to the call: the id is
 * a MEMBERSHIP id scoped to the repository, revoking does NOT revoke the
 * member's minted `sgk_` CI keys, self-revocation is permitted (and the caller's
 * next request answers 404, not 403), the owner cannot be removed, the JSON-
 * number id must be passed as a string, `members.manage` + 403 in SpecGuard's
 * own words, and the EITHER-credential rule with its agent-side 404 bound. The
 * wire examples above pin request shape and status rendering; nothing pinned
 * these clauses, so a clause-level edit (e.g. "Self-revocation is permitted" →
 * "refused", `members.manage` → `keys.manage`) left the suite green. Each
 * clause family is pinned on its OWN surface — the description, the argument
 * descriptions, the README section — because the README states them
 * independently and `readme.test.ts` is presence-only.
 *
 * The README section is sliced from its heading to the next `### `; `**`
 * emphasis is dropped and whitespace collapsed (the README wraps lines
 * mid-sentence) so assertions are line-wrap-proof.
 */
describe("remove_repository_member — the operative prose it teaches", () => {
  const HEADING = "### `remove_repository_member`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(removeRepositoryMember.description);
  const props = removeRepositoryMember.inputSchema.properties as Record<
    string,
    { description?: string } | undefined
  >;
  const repositoryIdArg = collapse(props["repository_id"]?.description ?? "");
  const memberIdArg = collapse(props["member_id"]?.description ?? "");

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 1500, "the README section is suspiciously short");
  });

  // -- The description's clause families --------------------------------------

  it("description: member_id is a MEMBERSHIP id, not a user id, scoped to repository_id — a foreign id is 404, never a cross-repository revoke", () => {
    assert.match(d, /named by `member_id` — a MEMBERSHIP id, not a user id — scoped to `repository_id`/);
    assert.match(
      d,
      /a membership id belonging to a different repository is refused 404, never a cross-repository revoke/,
    );
  });

  it("description: revoking does NOT revoke the member's minted sgk_ CI keys — the lever is revoke_repository_api_key", () => {
    assert.match(d, /Revoking does NOT revoke that member's minted CI keys/);
    assert.match(d, /any sgk_… keys they created on the repository keep authenticating by design/);
    assert.match(
      d,
      /the lever for those is the API-keys surface \(`revoke_repository_api_key`\), not this one/,
    );
  });

  it("description: self-revocation is permitted, and the caller's next request answers 404 — a former member is a non-member", () => {
    assert.match(
      d,
      /Self-revocation is permitted: a caller may remove their own membership, and their next request to the member routes answers 404/,
    );
    assert.match(
      d,
      /a former member is a non-member, so this tool cannot read the repository's members afterwards/,
    );
  });

  it("description: the repository owner's membership cannot be removed at all", () => {
    assert.match(
      d,
      /The repository owner's membership cannot be removed at all \(an owner holds everything by construction\)/,
    );
  });

  it("description: the membership id is served as `id` by list/add/update, as a JSON number, and must be passed as a string", () => {
    assert.match(d, /every member response carries it as `id`/);
    assert.match(
      d,
      /the rows `list_repository_members` serves, the `add_repository_member` 201 body, and `update_repository_member_permissions`'s response/,
    );
    assert.match(d, /serves that `id` as a JSON number \(a bigint column\)/);
    assert.match(
      d,
      /`member_id` is a string argument refused by name \("`member_id` must be a string\."\) before any request is made/,
    );
    assert.match(d, /pass a numeric-looking id such as `7` as a string, not as a number/);
  });

  it("description: authorization is the members.manage capability — a member without it is refused 403 in SpecGuard's own words; a 204 means revoked", () => {
    assert.match(
      d,
      /Authorization is the `members\.manage` capability — a member without it is refused 403 in SpecGuard's own words/,
    );
    assert.match(d, /A 204 means the membership is revoked/);
  });

  it("description: repository_id is the numeric id list_repositories reports, not the org/repo handle", () => {
    assert.match(
      d,
      /Takes `repository_id` — the numeric id `list_repositories` reports, not the `org\/repo` handle/,
    );
  });

  it("description: the EITHER-credential rule — the agent key is bounded by its members.manage grants (404, never a probe), the user key is add_repository's", () => {
    assert.match(
      d,
      /It authenticates with EITHER of this server's two member-administration credentials, whichever is set/,
    );
    assert.match(
      d,
      /SPECGUARD_AGENT_API_KEY \(an sga_… key — the call then reaches only the repositories granted onto that key at mint time, and only where the grant carries `members\.manage`; a repository outside that set answers 404 in SpecGuard's own words, never a probe here\)/,
    );
    assert.match(
      d,
      /when that is not set, SPECGUARD_USER_API_KEY \(an sgu_… key, the same credential `add_repository` writes with\)/,
    );
  });

  it("description: with both credentials set the agent key wins, so the revoke answers inside the same set list_repositories reports", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the revoke answers inside the same set `list_repositories` reports/,
    );
  });

  it("description: a DIFFERENT credential from the sgk_ repository key get_repository_overview uses", () => {
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses/,
    );
  });

  // -- The argument descriptions ----------------------------------------------

  it("repository_id argument: numeric id as add_repository returns and list_repositories reports, not the org/repo handle", () => {
    assert.match(repositoryIdArg, /The repository the membership belongs to — its numeric id/);
    assert.match(repositoryIdArg, /as `add_repository` returns and `list_repositories` reports, not the `org\/repo` handle/);
  });

  it("member_id argument: a MEMBERSHIP id (not a user id, not the handle), a foreign id is 404, sourced from `id`, pass as a string not a number", () => {
    assert.match(memberIdArg, /The id of the MEMBERSHIP row to revoke — not a user id, and not the handle/);
    assert.match(memberIdArg, /Scoped to `repository_id`: a foreign membership id is refused 404/);
    assert.match(
      memberIdArg,
      /the `id` field of a member row served by `list_repository_members`, `add_repository_member` or `update_repository_member_permissions`/,
    );
    assert.match(
      memberIdArg,
      /the server serves that id as a JSON number, so pass it on as a string, not as a number \("7", not 7\)/,
    );
  });

  // -- The README section's copy ----------------------------------------------

  it("README: argument table — member_id is the MEMBERSHIP row id, not a user id, scoped to repository_id (foreign id 404)", () => {
    assert.match(
      section,
      /\| `repository_id` \| the repository the membership belongs to — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org\/repo` handle \|/,
    );
    assert.match(
      section,
      /\| `member_id` \| the id of the membership row to revoke — not a user id, not the handle\. Scoped to `repository_id`: a foreign membership id is refused `404` \|/,
    );
  });

  it("README: revoking does NOT revoke minted CI keys; self-revocation is permitted and the next request is 404 not 403; the owner cannot be removed", () => {
    assert.match(section, /Revoking does NOT revoke that member's minted CI keys\./);
    assert.match(
      section,
      /Any `sgk_…` keys they created on the repository keep authenticating by design; the lever for those is the API-keys surface \(`revoke_repository_api_key`\), not this one/,
    );
    assert.match(
      section,
      /Self-revocation is permitted — after it, the caller's next request to the member routes answers `404`, not `403`/,
    );
    assert.match(section, /The repository owner's membership cannot be removed at all/);
  });

  it("README: member_id is a JSON number on the wire — pass it as a string; members.manage and 403 in SpecGuard's own sentence; 204 means revoked", () => {
    assert.match(section, /a JSON number on the wire, so pass it as a string, not as a number/);
    assert.match(
      section,
      /Authorization is the `members\.manage` capability; a member without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
    assert.match(section, /A `204` means it is revoked/);
  });

  it("README: the EITHER-credential rule — agent key bounded by members.manage grants (404), user key is add_repository's, agent wins when both are set", () => {
    assert.match(section, /It reads either of two credentials, whichever is set/);
    assert.match(
      section,
      /a different one from the `sgk_…` key `get_repository_overview` uses/,
    );
    assert.match(
      section,
      /`SPECGUARD_AGENT_API_KEY` \(`sga_…`\) when it is set: the call then reaches only the repositories granted onto that key at mint time, and only where the grant carries `members\.manage` — a repository outside that set is answered `404` in SpecGuard's own words/,
    );
    assert.match(
      section,
      /`SPECGUARD_USER_API_KEY` \(`sgu_…`\) when no agent key is set: the same \*?\*?person\*?\*? key `add_repository` reads/,
    );
    assert.match(
      section,
      /With both set the agent key wins, so the revoke answers inside the same set `list_repositories` reports/,
    );
  });
});
