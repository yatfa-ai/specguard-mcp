import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import addRepositoryMember from "../../src/tools/add-repository-member.js";
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
 * The 201 body `user_repository_members_controller#create` serves:
 * `{member: {id, handle, permissions, granted_by, created_at}}` — the `id`
 * being the membership id the edit/revoke tools name. Still WITHOUT any
 * grantor the caller might have submitted: `granted_by` is stamped
 * server-side from the credential.
 */
const BODY = JSON.stringify({
  member: {
    id: 7,
    handle: "alice",
    permissions: ["view"],
    granted_by: "octocat",
    created_at: "2026-08-29T00:00:00Z",
  },
});

describe("add_repository_member", () => {
  it("issues a POST with a TOP-LEVEL handle and permissions array", async () => {
    // Top-level `{handle, permissions}` — the shape `member_params` permits.
    // This fails on a nested body (`{member: {...}}`) and on a GET.
    const http = stubFetch({ status: 201, body: BODY });

    await addRepositoryMember.run(
      { repository_id: "42", handle: "alice", permissions: ["view"] },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), { handle: "alice", permissions: ["view"] });
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("passes the permissions array through INTACT on the wire", async () => {
    // The `text[]` trap: the server column silently DROPS a scalar, persisting
    // a member who holds nothing. The wire must carry the array itself.
    const http = stubFetch({ status: 201, body: BODY });

    await addRepositoryMember.run(
      { repository_id: "42", handle: "alice", permissions: ["view", "keys.manage"] },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const sent = JSON.parse(http.requests[0]?.body ?? "null");
    assert.ok(Array.isArray(sent.permissions), "permissions must reach the wire as an array");
    assert.deepEqual(sent.permissions, ["view", "keys.manage"]);
  });

  it("omits permissions from the wire entirely when not given, so the server's default applies", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    await addRepositoryMember.run(
      { repository_id: "42", handle: "alice" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.deepEqual(JSON.parse(http.requests[0]?.body ?? "null"), { handle: "alice" });
  });

  it("refuses a scalar permissions value BEFORE anything is sent", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    await rejects(
      addRepositoryMember.run(
        { repository_id: "42", handle: "alice", permissions: "view" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`permissions` must be an array of strings/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a write");
  });

  it("refuses a missing or blank handle before anything is sent", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    await rejects(
      addRepositoryMember.run({ repository_id: "42" }, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`handle` is required/,
    );
    await rejects(
      addRepositoryMember.run(
        { repository_id: "42", handle: " " },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`handle` must not be blank/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("returns the 201 body UNRESHAPED", async () => {
    const result = await addRepositoryMember.run(
      { repository_id: "42", handle: "alice", permissions: ["view"] },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 201, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("surfaces the server's resolution sentence on a 400 — the malformed-handle fork", async () => {
    // Each non-`:found` resolution earns its own 400 sentence server-side;
    // the tool must hand the sentence to the agent verbatim rather than
    // summarizing it.
    await rejects(
      addRepositoryMember.run(
        { repository_id: "42", handle: "https://github.com/alice" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 400,
            body: JSON.stringify({
              error: "bad_request",
              message: "That is not a GitHub handle. Send the login itself — octocat, not a profile URL or a display name.",
            }),
          }).fetch,
        }),
      ),
      /SpecGuard refused the request \(400\): That is not a GitHub handle\./,
    );
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      addRepositoryMember.run(
        { repository_id: "42", handle: "alice" },
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
      addRepositoryMember.run(
        { repository_id: "42", handle: "alice" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 401 branch — an sgk_ key is refused before any table is read", async () => {
    // The controller declares `accepts_user_credential`: a repository's own
    // key speaks for the repository, not for a person.
    await rejects(
      addRepositoryMember.run(
        { repository_id: "42", handle: "alice" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 401, body: "" }).fetch,
        }),
      ),
      /SpecGuard rejected the API key \(401\)/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The member WRITES answer BOTH key kinds since SPGD-973 (`dee29bf`) — the grant
    // is then bounded by the key's own set and its `members.manage` — so an agent
    // holding only the agent credential can grant a membership. Nothing on the
    // wire changes beyond the Bearer: same POST, same top-level body.
    const http = stubFetch({ status: 201, body: BODY });

    await addRepositoryMember.run(
      { repository_id: "42", handle: "alice" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), { handle: "alice" });
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

    await addRepositoryMember.run(
      { repository_id: "42", handle: "alice" },
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
      addRepositoryMember.run(
        { repository_id: "42", handle: "alice" },
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

describe("add_repository_member — the operative prose it teaches", () => {
  const HEADING = "### `add_repository_member`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(addRepositoryMember.description);
  const props = addRepositoryMember.inputSchema.properties as Record<
    string,
    { description?: string } | undefined
  >;
  const repositoryIdArg = collapse(props["repository_id"]?.description ?? "");
  const handleArg = collapse(props["handle"]?.description ?? "");
  const permissionsArg = collapse(props["permissions"]?.description ?? "");

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 1500, "the README section is suspiciously short");
  });

  // -- The description's clause families --------------------------------------

  it("description: grants a person access by GitHub handle, with an optional permissions list", () => {
    assert.match(
      d,
      /^Grants a person access to a SpecGuard repository by their GitHub handle, with an optional list of permissions/,
    );
  });

  it("description: the handle is the LOGIN itself — not a profile URL and not a display name", () => {
    assert.match(
      d,
      /The `handle` is the LOGIN itself — `octocat`, not a profile URL and not a display name: SpecGuard refuses each of those with its own sentence/,
    );
  });

  it("description: every other resolution failure (not signed in yet, archived, ambiguous) arrives as a distinguishable 400 naming the next move", () => {
    assert.match(
      d,
      /every other resolution failure \(nobody has signed in as that handle yet, the account is archived, the handle is ambiguous\) arrives as a distinguishable 400 message naming the exact next move/,
    );
  });

  it("description: the grantor is always the person behind the credential — an sgu_ key's person or the OWNER of the sga_ key — and no argument can name another", () => {
    assert.match(
      d,
      /The grantor recorded on the membership is always the person behind the credential — the one an sgu_… key speaks for, or the OWNER of the sga_… agent key/,
    );
    assert.match(d, /The server stamps it, and no argument can name a different one/);
  });

  it("description: the 201 `member` block's `id` is the MEMBERSHIP id the update/remove tools name", () => {
    assert.match(
      d,
      /On success \(201\) the response carries a `member` block whose `id` is the MEMBERSHIP id \(`handle`, `permissions`, `granted_by`, `created_at` alongside\)/,
    );
    assert.match(d, /the very identifier `update_repository_member_permissions` and `remove_repository_member` name/);
  });

  it("description: the membership id is not portable between repositories — a foreign id is refused 404 — so use it within this repository", () => {
    assert.match(
      d,
      /The id is not portable between repositories \(a foreign id is refused 404\), so use it within this repository/,
    );
  });

  it("description: permissions come from SpecGuard's own set, an unknown value is refused in its own words, and omitting the list grants no additional permissions", () => {
    assert.match(
      d,
      /Permissions are strings from SpecGuard's own set \(`view`, `keys\.manage`, `members\.manage`, `repo\.delete`\); an unknown value is refused in SpecGuard's own words/,
    );
    assert.match(d, /omitting the list grants access with no additional permissions/);
  });

  it("description: the repository owner cannot be added — they hold everything by construction", () => {
    assert.match(d, /The repository owner cannot be added \(they hold everything by construction\)/);
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

  it("description: with both credentials set the agent key wins, so the grant answers inside the same set list_repositories reports", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the grant answers inside the same set `list_repositories` reports/,
    );
  });

  it("description: under the agent credential the grant is bounded twice — no granting a permission the key lacks (400 naming the over-reach), and the membership is recorded against the key's owner", () => {
    assert.match(d, /Under the agent credential the grant is bounded twice/);
    assert.match(
      d,
      /the key cannot grant a permission it does not itself hold \(SpecGuard answers 400 naming the over-reach\)/,
    );
    assert.match(d, /and the membership is recorded against the key's owner/);
  });

  it("description: a DIFFERENT credential from the sgk_ repository key get_repository_overview uses", () => {
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses/,
    );
  });

  // -- The argument descriptions ----------------------------------------------

  it("repository_id argument: the numeric id add_repository returns and list_repositories reports, not the org/repo handle", () => {
    assert.match(
      repositoryIdArg,
      /its numeric id, as `add_repository` returns and `list_repositories` reports, not the `org\/repo` handle/,
    );
  });

  it("handle argument: the GitHub login — not a profile URL, not a display name — and the person must have signed in to SpecGuard at least once", () => {
    assert.match(
      handleArg,
      /The GitHub login of the person to add, e\.g\. `octocat` — not a profile URL and not a display name; SpecGuard refuses both with its own sentence/,
    );
    assert.match(handleArg, /The person must have signed in to SpecGuard at least once/);
  });

  it("permissions argument: an optional list from SpecGuard's own set; omit it to grant no additional permissions; an unknown value is refused in its own words", () => {
    assert.match(permissionsArg, /An optional list of permission strings from SpecGuard's own set/);
    assert.match(permissionsArg, /Omit it to grant access with no additional permissions/);
    assert.match(permissionsArg, /SpecGuard validates the values and refuses an unknown one in its own words/);
  });

  // -- The README section's copy ----------------------------------------------

  it("README: argument table — the handle is the login, not a URL or display name; permissions omitted grants no additional permissions", () => {
    assert.match(
      section,
      /\| `handle` \| the person's GitHub login — `octocat`, not a profile URL and not a display name; SpecGuard refuses both with its own sentence \|/,
    );
    assert.match(
      section,
      /\| `permissions` \| an optional list of permission strings \(`view`, `keys\.manage`, `members\.manage`, `repo\.delete`\); omit it to grant access with no additional permissions \|/,
    );
  });

  it("README: resolution failures are distinguishable 400s, and the grantor is the credential's person (sga_ key's OWNER) — no argument names another", () => {
    assert.match(
      section,
      /Each resolution failure — nobody has signed in as that handle yet, the account is archived, the handle is ambiguous, the handle is not a login — arrives as a distinguishable 400 message naming the exact next move/,
    );
    assert.match(
      section,
      /The grantor recorded on the membership is always the person behind the credential — the one an `sgu_…` key speaks for, or the owner of the `sga_…` agent key\. The server stamps it; no argument can name a different one/,
    );
  });

  it("README: the 201 `member.id` is the membership id the update/remove tools name; members.manage is the capability and a member without it is refused 403", () => {
    assert.match(
      section,
      /the response carries a `member` block whose `id` is the membership id \(alongside `handle`, `permissions`, `granted_by`, `created_at`\) — the identifier `update_repository_member_permissions` and `remove_repository_member` name/,
    );
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
      /With both set the agent key wins, so the grant answers inside the same set `list_repositories` reports/,
    );
  });

  it("README: under the agent credential the grant is bounded twice — over-grant answers 400 naming the over-reach, and the membership is recorded against the key's owner", () => {
    assert.match(section, /Under the agent credential the grant is bounded twice/);
    assert.match(
      section,
      /the key cannot grant a permission it does not itself hold — SpecGuard answers `400` naming the over-reach — and the membership is recorded against the key's owner/,
    );
  });
});
