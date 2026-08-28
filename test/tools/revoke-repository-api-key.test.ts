import assert from "node:assert/strict";
import { describe, it } from "node:test";
import revokeRepositoryApiKey from "../../src/tools/revoke-repository-api-key.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
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
    // (`repository.api_keys.find`), never a cross-repository delete. The
    // branch here is the deployment's; the bridge adds no check of its own.
    await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "999" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch(NO_CONTENT);

    const error = await rejects(
      revokeRepositoryApiKey.run(
        { repository_id: "42", key_id: "7" },
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
