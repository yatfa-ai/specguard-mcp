import assert from "node:assert/strict";
import { describe, it } from "node:test";
import addRepositoryMember from "../../src/tools/add-repository-member.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The 201 body `user_repository_members_controller#create` serves:
 * `{member: {handle, permissions, granted_by, created_at}}` — deliberately
 * WITHOUT a membership id, and WITHOUT any grantor the caller might have
 * submitted: `granted_by` is stamped server-side from the credential.
 */
const BODY = JSON.stringify({
  member: {
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

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    const error = await rejects(
      addRepositoryMember.run(
        { repository_id: "42", handle: "alice" },
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
