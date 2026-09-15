import assert from "node:assert/strict";
import { describe, it } from "node:test";
import revokeRepositoryAgentKey from "../../src/tools/revoke-repository-agent-key.js";
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
 * The 200 DISCLOSURE body `user_repository_agent_keys_controller#destroy`
 * serves — the API's substitute for the web confirm dialog: count first, then
 * the still-existing names, plus `deleted_repository_count` only when
 * positive. This fixture carries it positive, because a reshape that dropped
 * exactly that field is the defect the pass-through pin exists to catch.
 */
const BODY = JSON.stringify({
  agent_key: {
    id: 9,
    name: "automation",
    revoked_at: "2026-09-11T12:00:00Z",
    repository_count: 3,
    repositories: ["acme/alpha", "acme/beta"],
    deleted_repository_count: 1,
  },
});

/** The same body without the deleted-repositories clause — the common case. */
const BODY_NO_DELETIONS = JSON.stringify({
  agent_key: {
    id: 9,
    name: "automation",
    revoked_at: "2026-09-11T12:00:00Z",
    repository_count: 1,
    repositories: ["acme/alpha"],
  },
});

describe("revoke_repository_agent_key", () => {
  it("issues a DELETE scoped to the repository, with no body", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys/9");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("answers 200 WITH the disclosure body, parsed — not the sgk_ sibling's raw-204 handling", async () => {
    // The body IS the confirmation (the substitute for the web confirm
    // dialog), so the route through `requestJson`'s parse must land it in
    // `structured` whole: this fails if the call went through `deleteJson`'s
    // raw-text path and the tool never parsed the disclosure.
    const result = await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
    const agentKey = (result.structured as Record<string, unknown>)["agent_key"] as Record<
      string,
      unknown
    >;
    assert.equal(agentKey["revoked_at"], "2026-09-11T12:00:00Z");
    assert.equal(agentKey["deleted_repository_count"], 1);
  });

  it("passes the disclosure body through UNRESHAPED — deleted_repository_count included", async () => {
    const result = await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("passes the common disclosure through too — no deleted-repositories clause when none deleted", async () => {
    const result = await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({
        env: USER_ENV,
        fetch: stubFetch({ status: 200, body: BODY_NO_DELETIONS }).fetch,
      }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY_NO_DELETIONS));
    const agentKey = (result.structured as Record<string, unknown>)["agent_key"] as Record<
      string,
      unknown
    >;
    assert.equal("deleted_repository_count" in agentKey, false);
  });

  it("refuses a missing key_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`key_id` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a revoke");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "9" },
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
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "9" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 404 branch — the live.find_by/covers? fork's own answer for a foreign or replayed id", async () => {
    // A key id that is already revoked, or whose stored set does not cover
    // THIS repository, is a 404 server-side — never a cross-repository cut.
    // The branch here is the deployment's; the bridge adds no check of its own.
    await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "999" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The agent-keys endpoints answer BOTH key kinds since SPGD-1004 (`dfb9892`) —
    // the cut is then bounded by the key's own set and its `keys.manage` — so an
    // agent credential can revoke one of its own kind, completing the offboarding
    // arc without a person's `sgu_` key. Nothing on the wire changes beyond the
    // Bearer: same DELETE, same path, same 200-with-disclosure.
    const http = stubFetch({ status: 200, body: BODY });

    await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys/9");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sga_test");
  });

  it("prefers the agent key when BOTH credentials are set", async () => {
    // Scope consistency, not preference: the agent set is what
    // `list_repositories` reports and what the other agent-keyed tools answer
    // inside, so an answer from the person's wider set could name something
    // the agent's own discovery never showed. Asserted ONCE per tool — the
    // precedence is the helper's (`config.ts`), not this tool's behavior to
    // re-prove.
    const http = stubFetch({ status: 200, body: BODY });

    await revokeRepositoryAgentKey.run(
      { repository_id: "42", key_id: "9" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("names BOTH variables when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      revokeRepositoryAgentKey.run(
        { repository_id: "42", key_id: "9" },
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
