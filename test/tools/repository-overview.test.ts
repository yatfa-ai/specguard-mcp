import assert from "node:assert/strict";
import { describe, it } from "node:test";
import getRepositoryOverview from "../../src/tools/repository-overview.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

const ENV = { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

/** A response in the shape `Api::V1::RepositoriesController#show` renders. */
const BODY = JSON.stringify({
  repository: { id: 1, full_name: "acme/app", name: "app", registered_at: "2026-01-01T00:00:00Z" },
  api_key: { name: "ci", last_used_at: null },
  latest_run: {
    commit_sha: "abc123",
    branch: "main",
    total_specs: 20_000,
    annotated_specs: 1200,
    annotated_ratio: 0.06,
    duration_seconds: null,
    shards: null,
    suite_size_measured: true,
  },
  history_window: { branch_scope: "all_branches", branch: null, limit: 10, returned: 1 },
  history: [],
  branches_window: { returned: 1 },
  branches: [{ name: "main", run_count: 4, run_count_capped: false }],
});

describe("get_repository_overview — the request it makes", () => {
  it("GETs /api/v1/repository with the key as a Bearer token", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("passes ?branch= through when a branch is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({ branch: "main" }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?branch=main");
  });

  it("omits ?branch= entirely for a blank one, rather than sending an empty filter", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({ branch: "  " }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("does not double the slash when the endpoint carries a trailing one", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      {},
      toolContext({ env: { ...ENV, SPECGUARD_ENDPOINT: "https://sg.example.com/" }, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });
});

describe("get_repository_overview — the response it returns", () => {
  it("passes the body through untouched, nulls and all", async () => {
    // Every null in that body means "not measured" and is load-bearing: the
    // controller refuses to serialize a zero that would read as a measurement.
    // Reshaping here would discard exactly that distinction.
    const result = await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: BODY }).fetch }));

    assert.deepEqual(result.structured, JSON.parse(BODY));

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    assert.equal(latest["duration_seconds"], null);
    assert.equal(latest["shards"], null);
  });

  it("renders the same object as text, so the two halves cannot disagree", async () => {
    const result = await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: BODY }).fetch }));

    assert.deepEqual(JSON.parse(result.text), result.structured);
  });
});

describe("get_repository_overview — failures an agent can act on", () => {
  it("names the missing variables instead of attempting a call", async () => {
    const http = stubFetch({ body: BODY });

    await rejects(getRepositoryOverview.run({}, toolContext({ env: {}, fetch: http.fetch })), /SPECGUARD_ENDPOINT/);

    assert.equal(http.requests.length, 0, "no request should be made without config");
  });

  it("explains a 401 as a key problem, since SpecGuard answers it flat by design", async () => {
    const error = await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ status: 401, body: '{"error":"unauthorized"}' }).fetch })),
      /rejected the API key/,
    );

    assert.match(error.message, /per-repository/);
  });

  it("explains a 404 as an endpoint problem", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ status: 404 }).fetch })),
      /root URL/,
    );
  });

  it("reports an unexpected status with the body", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ status: 503, body: "upstream down" }).fetch })),
      /503.*upstream down/s,
    );
  });

  it("says so when the endpoint answers 200 with something that is not JSON", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: "<html>login</html>" }).fetch })),
      /not JSON/,
    );
  });

  it("names the endpoint when the deployment cannot be reached at all", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: failing })),
      /Could not reach https:\/\/sg\.example\.com/,
    );
  });

  it("rejects a branch of the wrong type", async () => {
    await rejects(getRepositoryOverview.run({ branch: 7 }, toolContext({ env: ENV })), /must be a string/);
  });
});
