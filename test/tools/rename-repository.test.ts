import assert from "node:assert/strict";
import { describe, it } from "node:test";
import renameRepository from "../../src/tools/rename-repository.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The 200 body `user_repositories_controller#update` serves:
 * `{repository: serialize(...)}` — the same serializer `list_repositories`
 * serves, but a rename receipt: the identity fields and `delivery_health`,
 * WITHOUT the list's per-entry `latest_run` (absent entirely, never null).
 * The test pins it UNRESHAPED.
 */
const BODY = JSON.stringify({
  repository: {
    id: 42,
    full_name: "octocat/new-name",
    created_at: "2026-08-01T00:00:00Z",
  },
});

describe("rename_repository", () => {
  it("issues a PATCH carrying TOP-LEVEL {github_full_name}", async () => {
    // `update_params` permits `github_full_name` at the TOP level only — this
    // fails on a GET/POST, and on a nested body (`{repository: {...}}`), which
    // the server would read as an empty update.
    const http = stubFetch({ status: 200, body: BODY });

    await renameRepository.run(
      { repository_id: "42", github_full_name: "octocat/new-name" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "PATCH", "this endpoint is PATCH, not POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), {
      github_full_name: "octocat/new-name",
    });
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("refuses a missing repository_id or github_full_name before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      renameRepository.run(
        { github_full_name: "octocat/new-name" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`repository_id` is required/,
    );
    await rejects(
      renameRepository.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`github_full_name` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a write");
  });

  it("returns the 200 body UNRESHAPED — the receipt shape, without the list's latest_run", async () => {
    const result = await renameRepository.run(
      { repository_id: "42", github_full_name: "octocat/new-name" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("describes the receipt shape exactly — latest_run absent, never \"the same shape\"", async () => {
    // The description is the one part of a tool nothing else exercises (the
    // SPGD-1067 instrument, see `list-repositories.test.ts`): an agent's only
    // pre-call knowledge of what this tool returns is this text, and the old
    // sentence — "the same shape `list_repositories` serves" — predicted a
    // `latest_run` member the receipt deliberately omits, because naming it
    // would assert CI state about a repository the endpoint knows was
    // untouched by the rename. Asserted rather than trusted to review.
    const description = renameRepository.description;

    // The old claim is GONE, not merely outnumbered.
    assert.doesNotMatch(
      description,
      /same shape\s+`list_repositories`/,
      "the description must not claim the rename receipt is the list_repositories shape",
    );

    // The corrected statement is pinned: same serializer, the receipt's own
    // member set, the absent-key-not-null reading, and the deliberate silence.
    assert.match(description, /same serializer\s+`list_repositories`/);
    assert.match(description, /identity\s+fields and `delivery_health`/);
    assert.match(description, /`latest_run` is absent entirely/);
    assert.match(description, /an absent key, never a null/);
    assert.match(description, /claims nothing about the repository's CI state/);
  });

  it("surfaces the server's whole 403 sentence when the grant is nil or stale", async () => {
    await rejects(
      renameRepository.run(
        { repository_id: "42", github_full_name: "octocat/new-name" },
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

  it("surfaces the server's 400 sentence on a taken name — 400, not 409", async () => {
    // `render_bad_request` answers `taken` as a 400; the branch that reaches
    // the agent must be the 400 one.
    await rejects(
      renameRepository.run(
        { repository_id: "42", github_full_name: "octocat/taken-name" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 400,
            body: JSON.stringify({
              error: "bad_request",
              message: "Name has already been taken",
            }),
          }).fetch,
        }),
      ),
      /SpecGuard refused the request \(400\): Name has already been taken/,
    );
  });

  it("keeps the 404 branch — an unknown repository id", async () => {
    await rejects(
      renameRepository.run(
        { repository_id: "999", github_full_name: "octocat/new-name" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("keeps the 401 branch — an sgk_ key is refused by accepts_user_credential", async () => {
    await rejects(
      renameRepository.run(
        { repository_id: "42", github_full_name: "octocat/new-name" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 401, body: "" }).fetch,
        }),
      ),
      /SpecGuard rejected the API key \(401\)/,
    );
  });

  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      renameRepository.run(
        { repository_id: "42", github_full_name: "octocat/new-name" },
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
