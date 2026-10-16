import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  it("sends `limit` as a query param after `near` when supplied, and ONLY then", async () => {
    const withLimit = stubFetch({ body: RANKED_BODY });
    await findTestsNearBehavior.run(
      { behavior: "rejects an expired token", limit: 25 },
      toolContext({ env: ENV, fetch: withLimit.fetch }),
    );
    assert.equal(
      withLimit.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?near=rejects+an+expired+token&limit=25",
    );

    const without = stubFetch({ body: RANKED_BODY });
    await findTestsNearBehavior.run(
      { behavior: "rejects an expired token" },
      toolContext({ env: ENV, fetch: without.fetch }),
    );
    assert.equal(
      without.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?near=rejects+an+expired+token",
    );
  });

  it("sends `limit` on the plural endpoint too, and does not clamp client-side", async () => {
    const http = stubFetch({ body: RANKED_BODY });
    await findTestsNearBehavior.run(
      { behavior: "rejects an expired token", repository: "42", limit: 500 },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );
    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repositories/42?near=rejects+an+expired+token&limit=500",
    );
  });

  it("treats `limit: null` as absent", async () => {
    const http = stubFetch({ body: RANKED_BODY });
    await findTestsNearBehavior.run(
      { behavior: "x behavior", limit: null },
      toolContext({ env: ENV, fetch: http.fetch }),
    );
    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?near=x+behavior");
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

  for (const [label, limit, pattern] of [
    ["zero", 0, /`limit` must be at least 1/],
    ["negative", -1, /`limit` must be at least 1/],
    ["fractional", 2.5, /`limit` must be an integer/],
    ["string", "10", /`limit` must be an integer/],
    ["NaN", Number.NaN, /`limit` must be an integer/],
    ["Infinity", Number.POSITIVE_INFINITY, /`limit` must be an integer/],
  ] as const) {
    it(`rejects a ${label} limit with an ArgumentError and makes no request`, async () => {
      const error = await rejects(
        findTestsNearBehavior.run(
          { behavior: "x behavior", limit },
          toolContext({ env: {}, fetch: failingFetch }),
        ),
        pattern,
      );
      assert.equal(error.name, "ArgumentError");
    });
  }

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

  it("tells the agent to read `truncated` and `limit` and to re-ask with a larger limit before paraphrasing", () => {
    const d = findTestsNearBehavior.description;
    assert.match(d, /`truncated`/);
    assert.match(d, /`limit`/);
    assert.match(d, /MORE matches exist than were returned/);
    assert.match(d, /larger optional `limit` \(max 50\)/);
    assert.match(d, /BEFORE paraphrasing/);
  });

  it("exposes `limit` as an optional integer, 1..50, and keeps the schema closed", () => {
    const limit = findTestsNearBehavior.inputSchema.properties?.["limit"] as Record<string, unknown>;
    assert.equal(limit["type"], "integer");
    assert.equal(limit["minimum"], 1);
    assert.equal(limit["maximum"], 50);
    assert.deepEqual(findTestsNearBehavior.inputSchema.required, ["behavior"]);
    assert.equal(findTestsNearBehavior.inputSchema.additionalProperties, false);
  });

  it("requires `behavior` and closes the schema", () => {
    assert.deepEqual(findTestsNearBehavior.inputSchema.required, ["behavior"]);
    assert.equal(findTestsNearBehavior.inputSchema.additionalProperties, false);
  });
});

/**
 * The tool's whole agent-facing contract is prose: the `description` and the README section. The
 * headline fragments above pin the honesty sentences; these pin the clauses an agent actually ACTS on
 * when it reads a `near` block — each on BOTH surfaces, because the README states them independently
 * and nothing else reads that section.
 *
 * The README section is sliced from its heading to the next `### `; `**` emphasis is dropped and
 * whitespace collapsed (the README wraps lines mid-sentence) so assertions are line-wrap-proof.
 */
describe("find_tests_near_behavior — the operative prose is pinned on the description AND the README", () => {
  const HEADING = "### `find_tests_near_behavior`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(findTestsNearBehavior.description);

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.match(section, /billed embedding call/);
    assert.ok(section.length > 1000, "the README section is suspiciously short");
  });

  it("pins the default page of 10 and the clamp to 50", () => {
    assert.match(d, /the default page is 10 hits/);
    assert.match(d, /it clamps your ask to 50/);
    assert.match(section, /omit it for the default page of 10/);
    assert.match(section, /The server clamps the ask to 50/);
    assert.match(section, /\*?1–50/);
  });

  it("pins what each of the three silences means, and that null is never []", () => {
    assert.match(d, /this says NOTHING about the suite/);
    assert.match(d, /the repository holds no identities, nothing has been ingested/);
    assert.match(d, /the nearest one's similarity is served so that "nothing near" is a finding you can check/);
    assert.match(d, /`null` and `\[\]` are never interchangeable here/);
    assert.match(section, /This says nothing about the suite/);
    assert.match(section, /the repository holds no identities; nothing has been ingested/);
    assert.match(section, /the nearest one's similarity is served so "nothing near" is a finding you can check/);
    assert.match(section, /`null` is never `\[\]`/);
  });

  it("pins that a name match and an intent match are different evidence", () => {
    assert.match(d, /are DIFFERENT EVIDENCE: a name match and an intent match are not the same claim/);
    assert.match(section, /are different evidence — read the source before leaning on a hit/);
  });

  it("pins the billing rule: a repeated phrase is cache-served and free, a novel one is billed, and the ask is live", () => {
    assert.match(d, /repeating a phrase is served from the cache and costs nothing/);
    assert.match(d, /a repeated phrase is cache-served and free, while each paraphrase is a novel phrase and one billed embed/);
    assert.match(d, /The ask is LIVE — computed on the request/);
    assert.match(section, /a repeated phrase is cache-served and free, while each paraphrase is a novel phrase and one billed embed/);
    assert.match(section, /a repeated phrase is served from the cache and costs nothing/);
    assert.match(section, /The ask is live — computed on the request/);
  });

  it("pins credential precedence (agent key preferred, wins when both are set) and `api_key` ABSENT rather than nulled", () => {
    assert.match(d, /the agent key preferred, the person key when no agent key is set/);
    assert.match(d, /with both set the agent key wins/);
    assert.match(d, /person and agent alike/);
    assert.match(d, /the `api_key` block is ABSENT from the body rather than nulled/);
    assert.match(section, /the \*?agent key \(`SPECGUARD_AGENT_API_KEY`, `sga_…`\), or — when no agent key is set — the user key/);
    assert.match(section, /the agent key preferred, the user key when no agent key is set/);
    assert.match(section, /`api_key` is absent from the body rather than nulled/);
  });
});
