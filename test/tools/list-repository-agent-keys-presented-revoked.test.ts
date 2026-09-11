import assert from "node:assert/strict";
import { describe, it } from "node:test";
import listRepositoryAgentKeysPresentedRevoked from "../../src/tools/list-repository-agent-keys-presented-revoked.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The 200 body `user_repository_agent_keys_controller#presented_revoked`
 * serves: `{agent_keys: [row]}`, one row per revoked key whose token is still
 * arriving — `revoked_at` and `last_refused_at` ride every row.
 */
const BODY = JSON.stringify({
  agent_keys: [
    {
      id: 9,
      name: "automation",
      owner: "Ada Lovelace",
      token_hint: "sga_a1b2…",
      repository_count: 3,
      revoked_at: "2026-09-10T09:00:00Z",
      last_refused_at: "2026-09-11T11:58:00Z",
    },
  ],
});

/** The EMPTY answer — "nothing is still arriving" — is a 200 body, not an error. */
const EMPTY_BODY = JSON.stringify({ agent_keys: [] });

describe("list_repository_agent_keys_presented_revoked", () => {
  it("issues a GET to the presented_revoked path scoped to the repository", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(
      request?.url,
      "https://sg.example.com/api/v1/repositories/42/agent_keys/presented_revoked",
    );
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("returns the rows UNRESHAPED — revoked_at and last_refused_at ride through", async () => {
    const result = await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.deepEqual(JSON.parse(result.text), result.structured);
    const row = ((result.structured as Record<string, unknown>)[
      "agent_keys"
    ] as unknown[])[0] as Record<string, unknown>;
    assert.equal(row["last_refused_at"], "2026-09-11T11:58:00Z");
  });

  it("passes the EMPTY answer through as an ANSWER — nothing is still arriving, not an absence of tracking", async () => {
    // The endpoint serves the negative deliberately so "no revoked key is
    // still presented" is distinguishable from "the API does not track that".
    // A tool that summarised an empty body into a count of its own would
    // erase exactly that distinction; this pins the pass-through.
    const result = await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: EMPTY_BODY }).fetch }),
    );

    assert.deepEqual(result.structured, { agent_keys: [] });
    assert.deepEqual(JSON.parse(result.text), { agent_keys: [] });
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        {},
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
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
      listRepositoryAgentKeysPresentedRevoked.run(
        { repository_id: "42" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 404 branch — the repository-existence fork's own answer", async () => {
    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
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
