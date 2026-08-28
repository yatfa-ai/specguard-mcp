import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createRepositoryApiKey from "../../src/tools/create-repository-api-key.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
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

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 201, body: BODY });

    const error = await rejects(
      createRepositoryApiKey.run(
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
