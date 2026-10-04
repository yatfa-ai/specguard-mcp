import assert from "node:assert/strict";
import { describe, it } from "node:test";

import findTestsNearBehavior from "../../src/tools/find-tests-near-behavior.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

const ENV = { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

/** Only the AGENT key — the environment the `repository` ask prefers. */
const AGENT_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_AGENT_API_KEY: "sga_test",
};

/** Only the USER key — the environment an sgu_-only deployment has. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

const REPOSITORY = { id: 1, full_name: "acme/app", name: "app", registered_at: "2026-01-01T00:00:00Z" };
const BASIS = "pgvector cosine distance; similarity = 1 − distance, higher is nearer";

/** The four shapes `NearProbe` serves, one fixture each. */
const RANKED_BODY = JSON.stringify({
  repository: REPOSITORY,
  near: {
    status: "ok",
    provider_fingerprint: "fp-1",
    provider_model: "embed-small",
    cache_served: false,
    similarity_floor: 0.85,
    similarity_basis: BASIS,
    weighed_run_id: 4102,
    identity_count: 1842,
    signal_sources: { intent: 1, name: 1 },
    ranked: [
      {
        text: "rejects an expired reset token",
        similarity: 0.93,
        signal_source: "intent",
        file_path: "spec/models/reset_token_spec.rb",
        example_count: 2,
        timed_count: 2,
        total_seconds: 0.4,
      },
      {
        text: "expired token",
        similarity: 0.88,
        signal_source: "name",
        file_path: "spec/requests/reset_spec.rb",
        example_count: 0,
        timed_count: 0,
        total_seconds: null,
      },
    ],
  },
});

const NOTHING_INGESTED_BODY = JSON.stringify({
  repository: REPOSITORY,
  near: {
    status: "ok",
    cache_served: true,
    similarity_floor: 0.85,
    similarity_basis: BASIS,
    weighed_run_id: null,
    identity_count: 0,
    signal_sources: {},
    ranked: [],
  },
});

const NONE_NEAR_BODY = JSON.stringify({
  repository: REPOSITORY,
  near: {
    status: "ok",
    cache_served: false,
    similarity_floor: 0.85,
    similarity_basis: BASIS,
    weighed_run_id: 4102,
    identity_count: 1842,
    signal_sources: {},
    ranked: [],
    best_below_floor_similarity: 0.61,
  },
});

const PROVIDER_UNCONFIGURED_BODY = JSON.stringify({
  repository: REPOSITORY,
  near: {
    status: "provider_unconfigured",
    cache_served: null,
    similarity_floor: 0.85,
    similarity_basis: BASIS,
    ranked: null,
  },
});

const EMBEDDING_FAILED_BODY = JSON.stringify({
  repository: REPOSITORY,
  near: {
    status: "embedding_failed",
    cache_served: null,
    similarity_floor: 0.85,
    similarity_basis: BASIS,
    ranked: null,
    error: "provider answered 429",
  },
});

describe("find_tests_near_behavior — the request it makes", () => {
  it("GETs /api/v1/repository with the TRIMMED phrase as `near`, under the sgk_ key", async () => {
    const http = stubFetch({ body: RANKED_BODY });

    await findTestsNearBehavior.run(
      { behavior: "  rejects an expired token  " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests.length, 1);
    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?near=rejects+an+expired+token",
    );
    assert.equal(http.requests[0]?.method, "GET");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("asks the PLURAL endpoint under the agent key when `repository` is named", async () => {
    const http = stubFetch({ body: RANKED_BODY });

    await findTestsNearBehavior.run(
      { behavior: "rejects an expired token", repository: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repositories/42?near=rejects+an+expired+token",
    );
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("asks the plural endpoint under the USER key when that is the only key set", async () => {
    const http = stubFetch({ body: RANKED_BODY });

    await findTestsNearBehavior.run(
      { behavior: "rejects an expired token", repository: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repositories/42?near=rejects+an+expired+token",
    );
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgu_test");
  });

  it("prefers the agent key when BOTH member credentials are set", async () => {
    const http = stubFetch({ body: RANKED_BODY });

    await findTestsNearBehavior.run(
      { behavior: "x behavior", repository: "42" },
      toolContext({ env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" }, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("treats a blank repository as NO ASK: the singular endpoint under the sgk_ slot", async () => {
    const http = stubFetch({ body: RANKED_BODY });

    await findTestsNearBehavior.run(
      { behavior: "x behavior", repository: "   " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?near=x+behavior");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("refuses the `repository` ask by name when NEITHER member key is set, before any request", async () => {
    const http = stubFetch({ body: RANKED_BODY });

    await rejects(
      findTestsNearBehavior.run(
        { behavior: "x behavior", repository: "42" },
        toolContext({ env: ENV, fetch: http.fetch }),
      ),
      /SPECGUARD_USER_API_KEY or SPECGUARD_AGENT_API_KEY is not set/,
    );

    assert.equal(http.requests.length, 0);
  });

  it("surfaces the endpoint's refusal rather than swallowing it", async () => {
    const http = stubFetch({ status: 401, body: JSON.stringify({ error: "unauthorized" }) });

    await rejects(
      findTestsNearBehavior.run({ behavior: "x behavior" }, toolContext({ env: ENV, fetch: http.fetch })),
      /401/,
    );
  });
});

describe("find_tests_near_behavior — argument refusals happen before config and before any request", () => {
  // `env: {}` would fail config resolution with a DIFFERENT error, so a
  // matching ArgumentError message proves the argument check ran first; the
  // stub fails the test outright if fetch is ever reached.
  const failingFetch = (() => {
    throw new Error("fetch must not be called");
  }) as unknown as typeof globalThis.fetch;

  for (const [label, args, pattern] of [
    ["missing", {}, /`behavior` is required/],
    ["null", { behavior: null }, /`behavior` is required/],
    ["non-string", { behavior: 42 }, /`behavior` must be a string/],
    ["empty", { behavior: "" }, /`behavior` must not be blank/],
    ["whitespace-only", { behavior: " \t\n " }, /`behavior` must not be blank/],
    ["NUL-containing", { behavior: "rejects\u0000 token" }, /NUL.*no ask.*`near: null`/s],
  ] as const) {
    it(`rejects a ${label} behavior with an ArgumentError`, async () => {
      const error = await rejects(
        findTestsNearBehavior.run(args, toolContext({ env: {}, fetch: failingFetch })),
        pattern,
      );
      assert.equal(error.name, "ArgumentError");
    });
  }

  it("rejects a NUL even when the phrase is otherwise valid and a repository is named", async () => {
    await rejects(
      findTestsNearBehavior.run(
        { behavior: "\u0000", repository: "42" },
        toolContext({ env: AGENT_ENV, fetch: failingFetch }),
      ),
      /NUL/,
    );
  });

  it("rejects a repository of the wrong type", async () => {
    await rejects(
      findTestsNearBehavior.run(
        { behavior: "x behavior", repository: 42 },
        toolContext({ env: {}, fetch: failingFetch }),
      ),
      /`repository` must be a string/,
    );
  });
});

describe("find_tests_near_behavior — the payload passes through unmodified", () => {
  const FIXTURES: Array<[string, string]> = [
    ["ranked hits", RANKED_BODY],
    ["ranked: [] with identity_count: 0 (nothing ingested)", NOTHING_INGESTED_BODY],
    ["ranked: [] with identity_count > 0 and best_below_floor_similarity", NONE_NEAR_BODY],
    ["provider_unconfigured with ranked: null", PROVIDER_UNCONFIGURED_BODY],
    ["embedding_failed with ranked: null", EMBEDDING_FAILED_BODY],
  ];

  for (const [label, body] of FIXTURES) {
    it(`returns the ${label} body verbatim, singular and plural`, async () => {
      for (const [env, args] of [
        [ENV, { behavior: "x behavior" }],
        [AGENT_ENV, { behavior: "x behavior", repository: "42" }],
        [USER_ENV, { behavior: "x behavior", repository: "42" }],
      ] as const) {
        const http = stubFetch({ body });
        const result = await findTestsNearBehavior.run(args, toolContext({ env, fetch: http.fetch }));

        assert.deepEqual(result.structured, JSON.parse(body));
        assert.equal(result.text, JSON.stringify(JSON.parse(body), null, 2));
      }
    });
  }

  it("keeps `ranked: null` and `ranked: []` distinct — no coalescing either way", async () => {
    const near = async (body: string) => {
      const http = stubFetch({ body });
      const result = await findTestsNearBehavior.run(
        { behavior: "x behavior" },
        toolContext({ env: ENV, fetch: http.fetch }),
      );
      return (result.structured as Record<string, Record<string, unknown>>)["near"]!;
    };

    for (const body of [PROVIDER_UNCONFIGURED_BODY, EMBEDDING_FAILED_BODY]) {
      const block = await near(body);
      assert.ok("ranked" in block);
      assert.strictEqual(block["ranked"], null);
    }
    for (const body of [NOTHING_INGESTED_BODY, NONE_NEAR_BODY]) {
      const block = await near(body);
      assert.deepEqual(block["ranked"], []);
    }

    // The two empty-list silences stay apart by their denominators.
    assert.strictEqual((await near(NOTHING_INGESTED_BODY))["identity_count"], 0);
    assert.ok(!("best_below_floor_similarity" in (await near(NOTHING_INGESTED_BODY))));
    assert.equal((await near(NONE_NEAR_BODY))["best_below_floor_similarity"], 0.61);
  });

  it("passes a server `near: null` through as null (the server's no-ask spelling)", async () => {
    const body = JSON.stringify({ repository: REPOSITORY, near: null });
    const http = stubFetch({ body });
    const result = await findTestsNearBehavior.run(
      { behavior: "x behavior" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );
    assert.strictEqual((result.structured as Record<string, unknown>)["near"], null);
  });
});

describe("find_tests_near_behavior — the description carries the honesty contract", () => {
  it("says in words that it never answers 'is this already tested?' and that a novel phrase is billed", () => {
    const d = findTestsNearBehavior.description;
    assert.match(d, /NEVER answers "is this already tested\?"/);
    assert.match(d, /never gates a write/);
    assert.match(d, /never issues a verdict/);
    assert.match(d, /ONE BILLED EMBEDDING CALL/);
    assert.match(d, /THREE SILENCES ARE DIFFERENT/);
    assert.match(d, /0\.95/);
  });

  it("requires `behavior` and closes the schema", () => {
    assert.deepEqual(findTestsNearBehavior.inputSchema.required, ["behavior"]);
    assert.equal(findTestsNearBehavior.inputSchema.additionalProperties, false);
  });
});
