import assert from "node:assert/strict";
import { describe, it } from "node:test";
import listRepositoryApiKeys from "../../src/tools/list-repository-api-keys.js";
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
 * The 200 body `user_repository_api_keys_controller#index` serves:
 * `{api_keys: [row]}` over the repository's key set, LIVE AND REVOKED alike —
 * the controller's own serialization, pass-through. Three rows, because the
 * vocabulary this fixture exists to pin reads across the population:
 *
 *   - row 11 is LIVE and PRESENTED (never rotated): `last_used_at` set,
 *     `rotated_at` null, `rotated_and_unused` false — the ordinary key;
 *   - row 12 is LIVE but ROTATED-AND-UNUSED — the stranded shape: its
 *     `rotated_at` is set and `rotated_and_unused` rides the row as true
 *     (the SPGD-1110 trio, live-scoped);
 *   - row 7 is REVOKED: `status` flips and `revoked_at` is present ONLY on
 *     this row — the two-writings-one-fact rule, so a live row's
 *     `revoked_at: null` never restates `status`.
 */
const BODY = JSON.stringify({
  api_keys: [
    {
      id: 11,
      name: "ci",
      token_hint: "sgk_a1b2…",
      created_at: "2026-09-08T12:00:00Z",
      created_by: "Ada Lovelace",
      last_used_at: "2026-09-14T11:58:00Z",
      rotated_at: null,
      rotated_and_unused: false,
      status: "live",
    },
    {
      id: 12,
      name: "old-ci",
      token_hint: "sgk_c3d4…",
      created_at: "2026-09-01T08:00:00Z",
      created_by: "Ada Lovelace",
      last_used_at: "2026-09-10T11:58:00Z",
      rotated_at: "2026-09-12T09:30:00Z",
      rotated_and_unused: true,
      status: "live",
    },
    {
      id: 7,
      name: "retired",
      token_hint: "sgk_e5f6…",
      created_at: "2026-08-20T08:00:00Z",
      created_by: "Grace Hopper",
      last_used_at: "2026-08-30T11:58:00Z",
      rotated_at: null,
      rotated_and_unused: false,
      status: "revoked",
      revoked_at: "2026-09-02T10:00:00Z",
    },
  ],
});

describe("list_repository_api_keys", () => {
  it("issues a GET to the api_keys index scoped to the repository", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryApiKeys.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/api_keys");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("returns the body UNRESHAPED — the id a revoke needs on a key this session did not mint stays where the controller put it", async () => {
    const result = await listRepositoryApiKeys.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    // `deepEqual` against the parsed fixture, not a hand-listed subset: the
    // listing is the id source for every row the session's mint responses did
    // not name, so any reshaping that dropped a field could drop the one the
    // revoke needs.
    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.equal(
      ((result.structured as Record<string, unknown>)["api_keys"] as unknown[])[0] !== undefined,
      true,
    );
    assert.deepEqual(JSON.parse(result.text), result.structured);

    // The full row vocabulary, named where it rides: the SPGD-1110 trio on the
    // rotated-and-unused row, and `revoked_at` present ONLY on the revoked
    // row — the exact shapes a reshape or a "clean-up" would be tempted to
    // normalize away.
    const rows = ((result.structured as Record<string, unknown>)["api_keys"] ??
      []) as Record<string, unknown>[];
    const stranded = rows.find((row) => row["id"] === 12);
    assert.equal(stranded?.["rotated_at"], "2026-09-12T09:30:00Z");
    assert.equal(stranded?.["last_used_at"], "2026-09-10T11:58:00Z");
    assert.equal(stranded?.["rotated_and_unused"], true);
    const revoked = rows.find((row) => row["id"] === 7);
    assert.equal(revoked?.["status"], "revoked");
    assert.equal(revoked?.["revoked_at"], "2026-09-02T10:00:00Z");
    const live = rows.find((row) => row["id"] === 11);
    assert.equal(live?.["last_used_at"], "2026-09-14T11:58:00Z");
    assert.equal("revoked_at" in (live ?? {}), false);
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      listRepositoryApiKeys.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      listRepositoryApiKeys.run(
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
      listRepositoryApiKeys.run(
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
      listRepositoryApiKeys.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The repository-api-keys controller declares BOTH credentials (`accepts_user_credential`
    // + `accepts_agent_credential`, SPGD-973) — the read is then bounded by the key's own set
    // and its `keys.manage` — so an agent credential can administer the sgk_ keys of a
    // repository in its own set, the rotation's own operator. Nothing on the wire changes
    // beyond the Bearer: same GET, same path.
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryApiKeys.run(
      { repository_id: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/api_keys");
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

    await listRepositoryApiKeys.run(
      { repository_id: "42" },
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
      listRepositoryApiKeys.run(
        { repository_id: "42" },
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
