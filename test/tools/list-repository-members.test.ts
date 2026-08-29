import assert from "node:assert/strict";
import { describe, it } from "node:test";
import listRepositoryMembers from "../../src/tools/list-repository-members.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The body `user_repository_members_controller#index` serves: memberships
 * only, ordered by handle — and NO membership id, NO `keys_minted`, both
 * deliberate omissions the tool's description restates.
 */
const BODY = JSON.stringify({
  members: [
    {
      handle: "alice",
      permissions: ["members.manage", "view"],
      granted_by: "octocat",
      created_at: "2026-08-29T00:00:00Z",
    },
    {
      handle: "octocat",
      permissions: [],
      granted_by: null,
      created_at: "2026-08-28T00:00:00Z",
    },
  ],
});

describe("list_repository_members", () => {
  it("issues a GET on the repository-scoped members path", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryMembers.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/members");
    assert.equal(request?.body, undefined, "a GET carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("returns the body UNRESHAPED — no id invented, no keys_minted fabricated", async () => {
    const result = await listRepositoryMembers.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("refuses a missing or blank repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      listRepositoryMembers.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` is required/,
    );
    await rejects(
      listRepositoryMembers.run(
        { repository_id: " " },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`repository_id` must not be blank/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a request");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    // A member without `members.manage` — the modal refusal on this endpoint.
    await rejects(
      listRepositoryMembers.run(
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

  it("keeps the 404 branch — a non-member caller's own answer", async () => {
    // RepositoryAuthorization's fork hides the repository's existence from a
    // non-member: 404, not 403.
    await rejects(
      listRepositoryMembers.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      listRepositoryMembers.run(
        { repository_id: "42" },
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
