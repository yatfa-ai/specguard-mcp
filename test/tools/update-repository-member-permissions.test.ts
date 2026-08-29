import assert from "node:assert/strict";
import { describe, it } from "node:test";
import updateRepositoryMemberPermissions from "../../src/tools/update-repository-member-permissions.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The 200 body `user_repository_members_controller#update` serves:
 * `{member: {handle, permissions, granted_by, created_at}}` — no membership
 * id, same deliberate omission as the list and the 201.
 */
const BODY = JSON.stringify({
  member: {
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

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      updateRepositoryMemberPermissions.run(
        { repository_id: "42", member_id: "7", permissions: ["view"] },
        toolContext({
          env: { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" },
          fetch: http.fetch,
        }),
      ),
      /SPECGUARD_USER_API_KEY is not set/,
    );

    assert.match(error.message, /sgu_… key/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });
});
