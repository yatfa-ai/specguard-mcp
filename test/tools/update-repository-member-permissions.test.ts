import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import updateRepositoryMemberPermissions from "../../src/tools/update-repository-member-permissions.js";
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
 * The 200 body `user_repository_members_controller#update` serves:
 * `{member: {id, handle, permissions, granted_by, created_at}}` — the
 * membership `id` served, same as the list and the 201.
 */
const BODY = JSON.stringify({
  member: {
    id: 7,
    handle: "alice",
    permissions: ["view", "keys.manage"],
    granted_by: "octocat",
    created_at: "2026-08-29T00:00:00Z",
  },
});

describe("update_repository_member_permissions", () => {
  it("issues a PATCH carrying TOP-LEVEL {permissions: []}", async () => {
    // `member_params` permits exactly `permissions` as an ARRAY, top-level —
    // this fails on a GET/POST, on a nested body (`{member: {...}}`), and on
    // a scalar body (the `text[]` silent-drop trap).
    const http = stubFetch({ status: 200, body: BODY });

    await updateRepositoryMemberPermissions.run(
      { repository_id: "42", member_id: "7", permissions: ["view", "keys.manage"] },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "PATCH", "this endpoint is PATCH, not POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members/7");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), {
      permissions: ["view", "keys.manage"],
    });
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("passes an EMPTY permissions array through intact on the wire", async () => {
    // Replacing with nothing is a legitimate call (keeps the membership, drops
    // every additional permission) — it must not be normalised into an absent
    // key, which the server would read as "no change submitted".
    const http = stubFetch({ status: 200, body: BODY });

    await updateRepositoryMemberPermissions.run(
      { repository_id: "42", member_id: "7", permissions: [] },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const sent = JSON.parse(http.requests[0]?.body ?? "null");
    assert.ok(Array.isArray(sent.permissions));
    assert.deepEqual(sent.permissions, []);
  });

  it("refuses a scalar permissions value BEFORE anything is sent", async () => {
    // The `text[]` trap on this verb is the worst one: a scalar on the wire
    // would be silently DROPPED server-side and persist a member holding
    // nothing, with a 200. Caught here, before the write.
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: "view" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`permissions` must be an array of strings/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a write");
  });

  it("refuses a missing permissions or member_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`permissions` is required/,
    );
    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", permissions: ["view"] },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`member_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("returns the 200 body UNRESHAPED", async () => {
    const result = await updateRepositoryMemberPermissions.run(
      { repository_id: "42", member_id: "7", permissions: ["view", "keys.manage"] },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: ["view"] },
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

  it("surfaces the server's validation sentence on a 400 — an unknown permission", async () => {
    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: ["root"] },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 400,
            body: JSON.stringify({
              error: "bad_request",
              message: "Permissions contains unknown value: root",
            }),
          }).fetch,
        }),
      ),
      /SpecGuard refused the request \(400\): Permissions contains unknown value: root/,
    );
  });

  it("falls back to the generic sentence on a non-conforming 403 body", async () => {
    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: ["view"] },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "<html>Forbidden</html>" }).fetch,
        }),
      ),
      /SpecGuard answered 403: <html>Forbidden<\/html>/,
    );
  });

  it("keeps the 404 branch — the scoping rule's own answer for a foreign membership id", async () => {
    // `find_membership!` scopes the id THROUGH the repository: a membership id
    // belonging to a DIFFERENT repository is a 404, never a cross-repository
    // write. The bridge adds no check of its own — the server is the gate.
    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "999", permissions: ["view"] },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("keeps the 401 branch — an sgk_ key is refused by accepts_user_credential", async () => {
    await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: ["view"] },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 401, body: "" }).fetch,
        }),
      ),
      /SpecGuard rejected the API key \(401\)/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The member WRITES answer BOTH key kinds since SPGD-973 (`dee29bf`) — the edit
    // is then bounded by the key's own set and its `members.manage` — so an agent
    // holding only the agent credential can replace a permission set. Nothing on
    // the wire changes beyond the Bearer: same PATCH, same top-level body.
    const http = stubFetch({ status: 200, body: BODY });

    await updateRepositoryMemberPermissions.run(
      { repository_id: "42", member_id: "7", permissions: ["view"] },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "PATCH");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members/7");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), { permissions: ["view"] });
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

    await updateRepositoryMemberPermissions.run(
      { repository_id: "42", member_id: "7", permissions: ["view"] },
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
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: ["view"] },
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

describe("update_repository_member_permissions — the operative prose it teaches", () => {
  const HEADING = "### `update_repository_member_permissions`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(updateRepositoryMemberPermissions.description);
  const props = updateRepositoryMemberPermissions.inputSchema.properties as Record<
    string,
    { description?: string } | undefined
  >;
  const memberIdArg = collapse(props["member_id"]?.description ?? "");
  const permissionsArg = collapse(props["permissions"]?.description ?? "");

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 1500, "the README section is suspiciously short");
  });

  // -- The description's clause families --------------------------------------

  it("description: it REPLACES a member's permission set", () => {
    assert.match(d, /^Replaces one member's permission set on a SpecGuard repository/);
  });

  it("description: member_id is a MEMBERSHIP id, not a user id, scoped to repository_id — a foreign id is 404, never a cross-repository write", () => {
    assert.match(d, /named by `member_id` — a MEMBERSHIP id, not a user id — and the id is SCOPED to `repository_id`/);
    assert.match(
      d,
      /a membership id belonging to a different repository is refused 404, never a cross-repository write/,
    );
  });

  it("description: `permissions` REPLACES the whole set — not merged — so name every permission the member should end with", () => {
    assert.match(
      d,
      /`permissions` REPLACES the whole set — it is not merged with what the member holds today, so name every permission the member should end with/,
    );
  });

  it("description: values come from SpecGuard's own set, and an unknown value is refused in SpecGuard's own words", () => {
    assert.match(
      d,
      /Values are strings from SpecGuard's own set \(`view`, `keys\.manage`, `members\.manage`, `repo\.delete`\); an unknown value is refused in SpecGuard's own words/,
    );
  });

  it("description: the membership id is served as `id` by list/add/update, as a JSON number, and must be passed as a string", () => {
    assert.match(d, /every member response carries it as `id`/);
    assert.match(
      d,
      /the rows `list_repository_members` serves, the `add_repository_member` 201 body, and this tool's own response/,
    );
    assert.match(d, /serves that `id` as a JSON number \(a bigint column\)/);
    assert.match(
      d,
      /`member_id` is a string argument refused by name \("`member_id` must be a string\."\) before any request is made/,
    );
    assert.match(d, /pass a numeric-looking id such as `7` as a string, not as a number/);
  });

  it("description: authorization is the members.manage capability — a member without it is refused 403 in SpecGuard's own words", () => {
    assert.match(
      d,
      /Authorization is the `members\.manage` capability — a member without it is refused 403 in SpecGuard's own words/,
    );
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

  it("description: with both credentials set the agent key wins, so the edit answers inside the same set list_repositories reports", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the edit answers inside the same set `list_repositories` reports/,
    );
  });

  it("description: under the agent credential the set is bounded twice — no granting a permission the key lacks (400 naming the over-reach), and the re-stamped grantor is the key's owner", () => {
    assert.match(d, /Under the agent credential the replacement set is bounded twice/);
    assert.match(
      d,
      /the key cannot grant a permission it does not itself hold \(SpecGuard answers 400 naming the over-reach\)/,
    );
    assert.match(d, /and the re-stamped grantor is the key's owner/);
  });

  it("description: a DIFFERENT credential from the sgk_ repository key get_repository_overview uses", () => {
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses/,
    );
  });

  // -- The argument descriptions ----------------------------------------------

  it("member_id argument: a MEMBERSHIP id (not a user id, not the handle), a foreign id is 404, sourced from `id`, pass as a string not a number", () => {
    assert.match(memberIdArg, /The id of the MEMBERSHIP row to edit — not a user id, and not the handle/);
    assert.match(memberIdArg, /Scoped to `repository_id`: a foreign membership id is refused 404/);
    assert.match(
      memberIdArg,
      /the `id` field of a member row served by `list_repository_members`, `add_repository_member` or this tool's own response/,
    );
    assert.match(
      memberIdArg,
      /the server serves that id as a JSON number, so pass it on as a string, not as a number \("7", not 7\)/,
    );
  });

  it("permissions argument: the COMPLETE new set, replacing what they hold, not merged; an empty array removes every additional permission but keeps the membership", () => {
    assert.match(permissionsArg, /The member's COMPLETE new permission set, replacing what they hold today/);
    assert.match(permissionsArg, /Not merged\./);
    assert.match(
      permissionsArg,
      /An empty array removes every additional permission while keeping the membership/,
    );
  });

  // -- The README section's copy ----------------------------------------------

  it("README: argument table — member_id is the MEMBERSHIP row id, not a user id, scoped to repository_id (foreign id 404)", () => {
    assert.match(
      section,
      /\| `member_id` \| the id of the membership row to edit — not a user id, not the handle\. Scoped to `repository_id`: a foreign membership id is refused `404` \|/,
    );
  });

  it("README: permissions is the member's complete new set — it replaces what they hold, it is not merged — and the whole set is replaced", () => {
    assert.match(
      section,
      /\| `permissions` \| the member's complete new permission set \(`view`, `keys\.manage`, `members\.manage`, `repo\.delete`\) — it replaces what they hold today, it is not merged \|/,
    );
    assert.match(
      section,
      /`permissions` replaces the whole set — name every permission the member should end with/,
    );
    assert.match(section, /an unknown value is refused with its own sentence, verbatim/);
  });

  it("README: member_id is a JSON number on the wire — pass it as a string; there is no name lookup", () => {
    assert.match(
      section,
      /serves that `id` as a JSON number \(the column is a bigint\), while `member_id` is a string argument refused by name before any request is made — pass a numeric-looking id such as `7` as a string, not as a number/,
    );
    assert.match(section, /There is no name-based lookup, and ids are scoped to the repository \(a foreign id is refused `404`\)/);
  });

  it("README: members.manage is the capability and a member without it is refused 403 with SpecGuard's own sentence", () => {
    assert.match(
      section,
      /Authorization is the `members\.manage` capability; a member without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
  });

  it("README: the EITHER-credential rule — agent key bounded by members.manage grants (404), user key is add_repository's, agent wins when both are set", () => {
    assert.match(section, /It reads either of two credentials, whichever is set/);
    assert.match(
      section,
      /`SPECGUARD_AGENT_API_KEY` \(`sga_…`\) when it is set: the call then reaches only the repositories granted onto that key at mint time, and only where the grant carries `members\.manage` — a repository outside that set is answered `404` in SpecGuard's own words/,
    );
    assert.match(
      section,
      /`SPECGUARD_USER_API_KEY` \(`sgu_…`\) when no agent key is set: the same person key `add_repository` reads/,
    );
    assert.match(
      section,
      /With both set the agent key wins, so the edit answers inside the same set `list_repositories` reports/,
    );
  });

  it("README: under the agent credential the set is bounded twice — over-grant answers 400 naming the over-reach, and the re-stamped grantor is the key's owner", () => {
    assert.match(section, /Under the agent credential the replacement set is bounded twice/);
    assert.match(
      section,
      /the key cannot grant a permission it does not itself hold — SpecGuard answers `400` naming the over-reach — and the re-stamped grantor is the key's owner/,
    );
  });
});
