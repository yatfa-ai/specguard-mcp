import assert from "node:assert/strict";
import { describe, it } from "node:test";
import removeRepositoryMember from "../../src/tools/remove-repository-member.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
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

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch(NO_CONTENT);

    const error = await rejects(
      removeRepositoryMember.run(
        { repository_id: "42", member_id: "7" },
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
