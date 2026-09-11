import assert from "node:assert/strict";
import { describe, it } from "node:test";
import listRepositoryAgentKeys from "../../src/tools/list-repository-agent-keys.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The 200 body `user_repository_agent_keys_controller#index` serves:
 * `{agent_keys: [row]}`, one row per LIVE key covering the repository —
 * the controller's own serialization, pass-through.
 */
const BODY = JSON.stringify({
  agent_keys: [
    {
      id: 9,
      name: "automation",
      owner: "Ada Lovelace",
      token_hint: "sga_a1b2…",
      repository_count: 3,
      permissions: "read only",
      created_at: "2026-09-08T12:00:00Z",
    },
  ],
});

describe("list_repository_agent_keys", () => {
  it("issues a GET to the agent_keys index scoped to the repository", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeys.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("returns the body UNRESHAPED — the id an agent needs for the revoke stays where the controller put it", async () => {
    const result = await listRepositoryAgentKeys.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    // `deepEqual` against the parsed fixture, not a hand-listed subset: the
    // listing is the ONLY id source on this bridge (no mint tool exists), so
    // any reshaping that dropped a field could drop the one the revoke needs.
    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.equal(
      ((result.structured as Record<string, unknown>)["agent_keys"] as unknown[])[0] !== undefined,
      true,
    );
    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      listRepositoryAgentKeys.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      listRepositoryAgentKeys.run(
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
      listRepositoryAgentKeys.run(
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
      listRepositoryAgentKeys.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      listRepositoryAgentKeys.run(
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
