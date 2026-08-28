import assert from "node:assert/strict";
import { describe, it } from "node:test";
import removeRepository from "../../src/tools/remove-repository.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** The `204` with NO body — the deployment's whole success answer. */
const NO_CONTENT = { status: 204, body: "" };

describe("remove_repository", () => {
  it("issues a DELETE — not a GET, not a POST — with no body", async () => {
    // `RecordedRequest.method` is upper-cased and defaulted the way `fetch`
    // itself defaults it, so this assertion fails exactly when the wire
    // changes: a GET or POST here deletes nothing on the platform.
    const http = stubFetch(NO_CONTENT);

    await removeRepository.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("succeeds on a 204 with an empty body, without parsing it as JSON", async () => {
    // The trap this verb introduces: `requestJson` JSON-parses every 2xx it
    // sees, which would turn this success into "the body was not JSON". The
    // stub serves a genuinely empty body; a deleteJson routed through the JSON
    // parse fails here, and one that skipped the status check fails above.
    const result = await removeRepository.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch(NO_CONTENT).fetch }),
    );

    assert.notEqual(result.text, "");
    assert.deepEqual(result.structured, { repository_id: "42", deleted: true });
  });

  it("refuses a missing or blank repository_id before anything is sent", async () => {
    const http = stubFetch(NO_CONTENT);

    await rejects(
      removeRepository.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` is required/,
    );
    await rejects(
      removeRepository.run({ repository_id: "  " }, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` must not be blank/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a delete");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    // A member holding only `view` — no `repo.delete` — gets this from every
    // one of these endpoints, and the agent's next move is inside the sentence.
    await rejects(
      removeRepository.run(
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
    // A proxy's HTML or a bare string must not be swallowed as though it were
    // the contract — the operator still sees what actually came back.
    await rejects(
      removeRepository.run(
        { repository_id: "42" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "<html>Forbidden</html>" }).fetch,
        }),
      ),
      /SpecGuard answered 403: <html>Forbidden<\/html>/,
    );
  });

  it("keeps the 404 branch: a wrong endpoint root, named for the operator", async () => {
    await rejects(
      removeRepository.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)/,
    );
  });

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch(NO_CONTENT);

    const error = await rejects(
      removeRepository.run(
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
