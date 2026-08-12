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
    // Served on every response. `null` is the server saying "you did not ask" —
    // it is populated only when `?spec_directory=` names an area.
    spec_directory_files: null,
  },
  history_window: { branch_scope: "all_branches", branch: null, limit: 10, returned: 1 },
  history: [],
  branches_window: { returned: 1 },
  branches: [{ name: "main", run_count: 4, run_count_capped: false }],
});

/**
 * The same response as `BODY`, as the server renders it once the drill-down was
 * asked for — the ONE key that changes.
 *
 * The area totals are deliberately larger than the rows they sit beside:
 * `file_count` is 31 against 2 returned rows, because the server serves the
 * AREA's figures next to a row list it truncated at `limit`. A client that
 * re-derived either from `rows` would be reporting the page's figure under the
 * area's name, so this fixture is built so that mistake would be visible.
 */
const DRILLED_BODY = JSON.stringify({
  ...JSON.parse(BODY),
  latest_run: {
    ...JSON.parse(BODY).latest_run,
    spec_directory_files: {
      path: "spec/models",
      rows: [
        { path: "spec/models/user_spec.rb", total_seconds: 12.5, recorded_count: 40, timed_count: 40 },
        // `total_seconds` is null, never 0.0: every example in this file went
        // untimed, and a zero would assert a file that cost nothing.
        { path: "spec/models/order_spec.rb", total_seconds: null, recorded_count: 8, timed_count: 0 },
      ],
      file_count: 31,
      recorded_count: 900,
      timed_count: 640,
      limit: 25,
    },
  },
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

  it("passes ?spec_directory= through when an area is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { spec_directory: "spec/models" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?spec_directory=spec%2Fmodels",
    );
  });

  it("omits ?spec_directory= entirely for a blank one, rather than opening a guaranteed-empty area", async () => {
    // `?spec_directory=` (blank) is "no ask" server-side, so sending it would be
    // a request for the drill-down that can only answer with nothing.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { spec_directory: "  " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

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

  it("hands back the drill-down populated when an area was asked for", async () => {
    const result = await getRepositoryOverview.run(
      { spec_directory: "spec/models" },
      toolContext({ env: ENV, fetch: stubFetch({ body: DRILLED_BODY }).fetch }),
    );

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    const drilled = latest["spec_directory_files"] as Record<string, unknown>;

    assert.deepEqual(drilled, JSON.parse(DRILLED_BODY).latest_run.spec_directory_files);

    // The area's own totals, NOT the returned page's — served beside a row list
    // the server truncated at `limit`, and passed through as they arrived.
    assert.equal(drilled["file_count"], 31);
    assert.equal((drilled["rows"] as unknown[]).length, 2);

    // And the null survives the hop for the same reason every other null here does.
    assert.equal((drilled["rows"] as Record<string, unknown>[])[1]?.["total_seconds"], null);
  });

  it("leaves the drill-down null when no area was asked for", async () => {
    // The regression lock on the whole change: adding the parameter must not
    // make the tool ask for something the agent did not.
    const result = await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: BODY }).fetch }));

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    assert.equal(latest["spec_directory_files"], null);
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

  it("rejects a spec_directory of the wrong type, naming it", async () => {
    // The server treats a non-String as no ask at all and renders the page it
    // rendered before the parameter existed — a silent wrong answer. Refusing
    // here tells the caller which argument it got wrong instead.
    await rejects(
      getRepositoryOverview.run({ spec_directory: ["spec/models"] }, toolContext({ env: ENV })),
      /`spec_directory` must be a string/,
    );
  });
});

/**
 * Every one of these messages ends by telling the operator to go and check the
 * endpoint variable — so each has to name the variable they actually set.
 *
 * The endpoint check in `requireApiConfig` learned this first; the HTTP client
 * one layer out did not, and said `SPECGUARD_ENDPOINT` unconditionally. Someone
 * who followed the SPGD-310 brief and set `SPECGUARD_URL` was sent to fix a
 * variable that does not exist in their config. These pin the whole set rather
 * than the one message that prompted the fix, because the next HTTP tool
 * inherits `ApiConfig` and should inherit the naming with it.
 */
describe("get_repository_overview — diagnostics name the variable the operator set", () => {
  const VIA_ALIAS = { SPECGUARD_URL: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;

  const cases: ReadonlyArray<{ what: string; context: () => Parameters<typeof getRepositoryOverview.run>[1]; expect: RegExp }> = [
    {
      what: "unreachable deployment",
      context: () => toolContext({ env: VIA_ALIAS, fetch: unreachable }),
      expect: /Check SPECGUARD_URL and that the deployment is reachable/,
    },
    {
      what: "404",
      context: () => toolContext({ env: VIA_ALIAS, fetch: stubFetch({ status: 404 }).fetch }),
      expect: /Check that SPECGUARD_URL is the deployment's root URL/,
    },
    {
      what: "200 with a non-JSON body",
      context: () => toolContext({ env: VIA_ALIAS, fetch: stubFetch({ body: "<html>login</html>" }).fetch }),
      expect: /Check that SPECGUARD_URL points at a SpecGuard deployment/,
    },
  ];

  for (const { what, context, expect } of cases) {
    it(`names SPECGUARD_URL, not SPECGUARD_ENDPOINT, for ${what}`, async () => {
      const error = await rejects(getRepositoryOverview.run({}, context()), expect);

      assert.doesNotMatch(error.message, /SPECGUARD_ENDPOINT/);
    });
  }

  it("still says SPECGUARD_ENDPOINT when that is the variable in use", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: unreachable })),
      /Check SPECGUARD_ENDPOINT and that the deployment is reachable/,
    );
  });
});
