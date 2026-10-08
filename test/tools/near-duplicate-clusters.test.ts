import assert from "node:assert/strict";
import { describe, it } from "node:test";

import getRepositoryOverview from "../../src/tools/repository-overview.js";
import nearDuplicateClusters from "../../src/tools/near-duplicate-clusters.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

const ENV = { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

/** Only the AGENT key — the environment the `repository` ask reads. */
const AGENT_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_AGENT_API_KEY: "sga_test",
};

/** Only the USER key — the environment an sgu_-only deployment has. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * A plain `GET /api/v1/repository` response, in the shape
 * `Api::V1::RepositoriesController#show` renders — MINIMAL but honest: the keys
 * this tool's contract turns on are the `repository` context and the
 * `near_duplicates` key itself, which the server serves on EVERY response,
 * `null` spelling "you did not ask" (SPGD-703: no ask ⇒ key present, `null`,
 * zero queries).
 */
const NO_ASK_BODY = JSON.stringify({
  repository: { id: 1, full_name: "acme/app", name: "app", registered_at: "2026-01-01T00:00:00Z" },
  // The server's no-ask spelling: the key is PRESENT and `null`, which is how a
  // client distinguishes "not asked" from "asked, nothing alike" (the latter is
  // `clusters: []` with real counts — see ASKED_BODY).
  near_duplicates: null,
});

/**
 * The SAME response with the ask answered — the ONE key that changes, in the
 * shape `RepositoryOverview#serialized_near_duplicates` renders.
 *
 * Every trap the serializer's own comments name is built into these numbers:
 *  - `member_count` vs `example_count` are DIFFERENT GRAINS — the first cluster
 *    is the three-example table-driven loop: ONE member (one body text, seen
 *    across every run) and THREE examples (in the one run `weighed_run_id`
 *    names). A fixture with `member_count === example_count` everywhere could
 *    not fail a client that folded them, which is the exact flattening the
 *    serializer exists to prevent.
 *  - `total_seconds` is `null` on the second cluster's untimed member — never
 *    `0.0`, which would assert an example that cost nothing.
 *  - `unobserved_members: true` on the second cluster: one of its two member
 *    identities was not observed in the weighed run, so the member list does
 *    NOT reconcile against that run's examples — stated, not inferable.
 *  - `similarity_range` is `[strongest, weakest]` per cluster, not one figure:
 *    membership is transitive, similarity is not.
 *  - The disclosure pair (`similarity_floor`, `similarity_basis`) sits FIRST in
 *    the block, ahead of every figure it qualifies — pinned in that order so a
 *    reorder is a red test rather than a silent contract change.
 *  - `truncated: false` with `cluster_count: 2` beside a 2-row `clusters`: the
 *    counts describe the WHOLE census, the list is the page. (`truncated: true`
 *    with a short list is the other spelling of that; not fixtured here because
 *    the pass-through contract is the same.)
 */
const ASKED_BODY = JSON.stringify({
  repository: { id: 1, full_name: "acme/app", name: "app", registered_at: "2026-01-01T00:00:00Z" },
  near_duplicates: {
    similarity_floor: 0.94,
    similarity_basis: "trigram jaccard over normalised bodies (feature hashing, retired provider; shape unchanged)",
    weighed_run_id: 4102,
    cluster_count: 2,
    truncated: false,
    saturated_identity_count: 0,
    unresolved_count: 0,
    recorded_count: 1_842,
    identity_count: 1_842,
    clustered_identity_count: 4,
    clustered_timed_count: 3,
    clustered_example_count: 5,
    clusters: [
      {
        signal_source: "body",
        member_count: 1,
        example_count: 3,
        total_seconds: 0.91,
        timed_count: 3,
        similarity_range: [0.99, 0.99],
        unobserved_members: false,
        members: [
          {
            text: "validates the email format",
            file_path: "app/models/user.rb",
            line_number: 42,
            example_count: 3,
            total_seconds: 0.91,
          },
        ],
      },
      {
        signal_source: "body",
        member_count: 2,
        example_count: 2,
        total_seconds: 1.5,
        timed_count: 1,
        similarity_range: [0.97, 0.95],
        unobserved_members: true,
        members: [
          {
            text: "is valid",
            file_path: "app/models/order.rb",
            line_number: 9,
            example_count: 1,
            total_seconds: 1.5,
          },
          // `total_seconds: null`, never 0.0 — this member went untimed in the
          // weighed run, and a zero would assert an example that cost nothing.
          {
            text: "is valid",
            file_path: "app/models/cart.rb",
            line_number: 14,
            example_count: 1,
            total_seconds: null,
          },
        ],
      },
    ],
  },
});

describe("near_duplicate_clusters — the request it makes", () => {
  it("GETs /api/v1/repository WITH the ask, using the key as a Bearer token", async () => {
    const http = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?near_duplicates=true");
    assert.equal(http.requests[0]?.method, "GET");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("sends the ask as `true` specifically, never a falsy spelling the server would still open", async () => {
    // The server reads only that the key is PRESENT — `?near_duplicates=false`
    // opens the census exactly as `=true` does — so the one honest wire form
    // for a tool whose whole purpose is the ask is the affirmative spelling.
    // This assertion pins that the tool did not accidentally send `false`,
    // which would work identically server-side while saying the opposite.
    const http = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.ok(!http.requests[0]?.url.includes("near_duplicates=false"));
    assert.ok(http.requests[0]?.url.includes("near_duplicates=true"));
  });

  it("names a repository and asks the PLURAL endpoint the same question, under the agent key", async () => {
    const http = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run(
      { repository: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    // The ask is UNCHANGED — spelled `true`, the affirmative, because the
    // server reads only that the key is present — and the credential moves
    // with the endpoint, because the deployment refuses each prefix kind in
    // the other's place before it reads a table.
    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories/42?near_duplicates=true");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("censuses the named repository with the USER key when that is the only key set", async () => {
    // SPGD-1106: the plural route answers the sgu_ person key too — the same
    // shared body, the same census, with no `api_key` block for ANY credential
    // — so an sgu_-only deployment is no longer refused at the bridge tip
    // before any request. The ask is unchanged; nothing on the wire changes
    // beyond the Bearer.
    const http = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run(
      { repository: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories/42?near_duplicates=true");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgu_test");
  });

  it("prefers the agent key when BOTH member credentials are set", async () => {
    // Scope consistency, not preference — the same precedence every
    // either-credential tool keeps since SPGD-953/1070/1097. Asserted ONCE per
    // tool: the precedence is the helper's (`config.ts`), not this tool's
    // behavior to re-prove.
    const http = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run(
      { repository: "42" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("treats a blank repository as NO ASK: the singular census, under the sgk_ slot", async () => {
    const http = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run(
      { repository: "   " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?near_duplicates=true");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("refuses the `repository` ask by name when NEITHER member key is set, before any request", async () => {
    // SPGD-1106 moved this pin's message: the plural path no longer demands
    // the agent key specifically — either member credential answers it — so
    // the refusal is the helper's plural rule, naming BOTH variables in one
    // sentence. The `sgk_` slot being set is correct and is not the problem.
    const http = stubFetch({ body: ASKED_BODY });

    const error = await rejects(
      nearDuplicateClusters.run(
        { repository: "42" },
        toolContext({ env: ENV, fetch: http.fetch }),
      ),
      /SPECGUARD_USER_API_KEY or SPECGUARD_AGENT_API_KEY is not set/,
    );

    assert.match(error.message, /sgu_… key/);
    assert.match(error.message, /sga_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY is not set/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });

  it("rejects a repository of the wrong type before any config is resolved", async () => {
    const http = stubFetch({ body: ASKED_BODY });

    await rejects(
      nearDuplicateClusters.run({ repository: 42 }, toolContext({ env: {}, fetch: http.fetch })),
      /`repository` must be a string/,
    );

    assert.equal(http.requests.length, 0);
  });

  it("returns the plural endpoint's census body with the same shape intact", async () => {
    // The pass-through contract does not fork on the subject: whatever path
    // served it, the whole body goes back as it arrived.
    const http = stubFetch({ body: ASKED_BODY });

    const result = await nearDuplicateClusters.run(
      { repository: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(ASKED_BODY));
    assert.equal(result.text, JSON.stringify(JSON.parse(ASKED_BODY), null, 2));
  });

  it("surfaces the endpoint's refusal rather than swallowing it", async () => {
    const http = stubFetch({ status: 401, body: JSON.stringify({ error: "unauthorized" }) });

    await rejects(
      nearDuplicateClusters.run({}, toolContext({ env: ENV, fetch: http.fetch })),
      /401/,
    );
  });
});

describe("near_duplicate_clusters — the payload it returns", () => {
  it("returns the clusters block WITH the ask sent, its shape intact", async () => {
    const http = stubFetch({ body: ASKED_BODY });

    const result = await nearDuplicateClusters.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.deepEqual(result.structured, JSON.parse(ASKED_BODY));
    const block = (result.structured as Record<string, unknown>)["near_duplicates"] as Record<string, unknown>;

    // The disclosure pair is served FIRST, ahead of every figure it qualifies.
    assert.deepEqual(Object.keys(block).slice(0, 2), ["similarity_floor", "similarity_basis"]);

    // The two grains served side by side and DIFFERENT, so folding them is a
    // visible error: the table-driven loop is 1 member / 3 examples.
    const first = (block["clusters"] as Array<Record<string, unknown>>)[0]!;
    assert.equal(first["member_count"], 1);
    assert.equal(first["example_count"], 3);

    // `null` where nothing was measured, never a zero that reads as free.
    const untimed = ((block["clusters"] as Array<Record<string, unknown>>)[1]!["members"] as Array<
      Record<string, unknown>
    >)[1]!;
    assert.equal(untimed["total_seconds"], null);

    // The counts describe the WHOLE census; the list is the page.
    assert.equal(block["cluster_count"], 2);
    assert.equal((block["clusters"] as unknown[]).length, 2);
    assert.equal(block["truncated"], false);

    // The text rendering is the same object verbatim, not a summary of it.
    assert.equal(result.text, JSON.stringify(JSON.parse(ASKED_BODY), null, 2));
  });

  it("passes the server's no-ask spelling (`near_duplicates: null`) through UNCHANGED when nothing asked", async () => {
    // The gate itself is the platform's contract and this tool cannot trigger
    // the no-ask state — it always sends the ask. What this pins is the OTHER
    // half of the contract the tool's description teaches: a plain overview
    // call (no parameter) is answered with the key PRESENT and `null`, the
    // server's "you did not ask" spelling — NOT an absent key and NOT an empty
    // block, which would make `near_duplicates: null` on this tool's response
    // ambiguous between "census says nothing alike" and "was never run".
    const http = stubFetch({ body: NO_ASK_BODY });

    const result = await getRepositoryOverview.run(
      {},
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    // The plain call sent NO ask — nothing on the URL but the path.
    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    assert.ok("near_duplicates" in parsed);
    assert.equal(parsed["near_duplicates"], null);
  });

  it("keeps the ask OFF the plain overview when other parameters are sent", async () => {
    // The cost gate must survive composition: an agent drilling the overview
    // with every other parameter it accepts must not silently pay the census.
    const http = stubFetch({ body: NO_ASK_BODY });

    await getRepositoryOverview.run(
      {
        branch: "main",
        spec_directory: "spec/models",
        unannotated_examples: true,
        commit_sha: "abc123",
      },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.ok(!http.requests[0]?.url.includes("near_duplicates"));
  });
});

describe("near_duplicate_clusters — the bounded view (`summary`, `cluster`)", () => {
  const SUMMARY_BODY = JSON.stringify({
    repository: { id: 1, full_name: "acme/app" },
    near_duplicates_summary: { cluster_count: 1, clusters: [{ rank: 1, files_seen: ["a_spec.rb"], file_count: 1, declared_layers: [] }] },
  });
  const CLUSTER_BODY = JSON.stringify({
    repository: { id: 1, full_name: "acme/app" },
    near_duplicate_cluster: { requested: 3, rank: 3, cluster_count: 5, member_listing: "members", cluster: { members: [] } },
  });
  const BOTH_BODY = JSON.stringify({
    near_duplicates_summary: { clusters: [] },
    near_duplicate_cluster: null,
  });

  it("`summary: true` sends ONLY the summary ask, with no `near_duplicates` key", async () => {
    const http = stubFetch({ body: SUMMARY_BODY });

    await nearDuplicateClusters.run({ summary: true }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?near_duplicates_summary=true");
    assert.ok(!http.requests[0]?.url.includes("near_duplicates=true"));
  });

  it("`summary: true` with a repository goes to the plural endpoint under the agent key", async () => {
    const http = stubFetch({ body: SUMMARY_BODY });

    await nearDuplicateClusters.run(
      { summary: true, repository: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories/42?near_duplicates_summary=true");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("`cluster: 3` sends `near_duplicate_cluster=3` and not the whole-census ask", async () => {
    const http = stubFetch({ body: CLUSTER_BODY });

    await nearDuplicateClusters.run({ cluster: 3 }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?near_duplicate_cluster=3");
    assert.ok(!http.requests[0]?.url.includes("near_duplicates="));
  });

  it("sends both keys, once each, when both arguments are supplied", async () => {
    const http = stubFetch({ body: BOTH_BODY });

    await nearDuplicateClusters.run({ summary: true, cluster: 2 }, toolContext({ env: ENV, fetch: http.fetch }));

    const url = new URL(http.requests[0]?.url ?? "");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["near_duplicate_cluster", "near_duplicates_summary"]);
    assert.equal(url.searchParams.get("near_duplicates_summary"), "true");
    assert.equal(url.searchParams.get("near_duplicate_cluster"), "2");
  });

  it("`summary: false` sends the byte-identical no-argument request", async () => {
    const plain = stubFetch({ body: ASKED_BODY });
    const off = stubFetch({ body: ASKED_BODY });

    await nearDuplicateClusters.run({}, toolContext({ env: ENV, fetch: plain.fetch }));
    await nearDuplicateClusters.run({ summary: false }, toolContext({ env: ENV, fetch: off.fetch }));

    assert.equal(off.requests[0]?.url, plain.requests[0]?.url);
    assert.equal(off.requests[0]?.url, "https://sg.example.com/api/v1/repository?near_duplicates=true");
  });

  for (const bad of [0, -1, 2.5, "3"]) {
    it(`refuses cluster ${JSON.stringify(bad)} as an ArgumentError before any request`, async () => {
      const http = stubFetch({ body: CLUSTER_BODY });

      await rejects(
        nearDuplicateClusters.run({ cluster: bad }, toolContext({ env: ENV, fetch: http.fetch })),
        /`cluster`/,
      );
      assert.equal(http.requests.length, 0);
    });
  }

  it("refuses a non-boolean `summary` before any request", async () => {
    const http = stubFetch({ body: SUMMARY_BODY });

    await rejects(
      nearDuplicateClusters.run({ summary: "true" }, toolContext({ env: ENV, fetch: http.fetch })),
      /`summary` must be a boolean/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("throws naming `near_duplicates_summary` when the asked-for key is ABSENT (old deployment)", async () => {
    const http = stubFetch({ body: NO_ASK_BODY });

    await rejects(
      nearDuplicateClusters.run({ summary: true }, toolContext({ env: ENV, fetch: http.fetch })),
      /near_duplicates_summary.*predates the bounded/s,
    );
  });

  it("throws naming `near_duplicate_cluster` when the asked-for key is ABSENT (old deployment)", async () => {
    const http = stubFetch({ body: NO_ASK_BODY });

    await rejects(
      nearDuplicateClusters.run({ cluster: 2 }, toolContext({ env: ENV, fetch: http.fetch })),
      /near_duplicate_cluster.*predates the bounded/s,
    );
  });

  it("passes a PRESENT `null` through for both keys (the server's own answer)", async () => {
    const summaryNull = stubFetch({ body: JSON.stringify({ near_duplicates_summary: null }) });
    const clusterNull = stubFetch({
      body: JSON.stringify({ near_duplicate_cluster: { requested: 99, cluster: null } }),
    });
    const bareClusterNull = stubFetch({ body: JSON.stringify({ near_duplicate_cluster: null }) });

    const a = await nearDuplicateClusters.run({ summary: true }, toolContext({ env: ENV, fetch: summaryNull.fetch }));
    const b = await nearDuplicateClusters.run({ cluster: 99 }, toolContext({ env: ENV, fetch: clusterNull.fetch }));
    const c = await nearDuplicateClusters.run({ cluster: 99 }, toolContext({ env: ENV, fetch: bareClusterNull.fetch }));

    assert.deepEqual(a.structured, { near_duplicates_summary: null });
    assert.deepEqual(b.structured, { near_duplicate_cluster: { requested: 99, cluster: null } });
    assert.deepEqual(c.structured, { near_duplicate_cluster: null });
  });

  it("does not demand a bounded key when none was asked for", async () => {
    const http = stubFetch({ body: NO_ASK_BODY });

    const result = await nearDuplicateClusters.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.deepEqual(result.structured, JSON.parse(NO_ASK_BODY));
  });

  it("advertises exactly repository, summary and cluster on a closed schema", () => {
    const schema = nearDuplicateClusters.inputSchema as {
      properties: Record<string, { type?: string; minimum?: number }>;
      additionalProperties?: boolean;
    };

    assert.deepEqual(Object.keys(schema.properties).sort(), ["cluster", "repository", "summary"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties["cluster"]?.type, "integer");
    assert.equal(schema.properties["cluster"]?.minimum, 1);
    assert.equal(schema.properties["summary"]?.type, "boolean");
  });
});

describe("near_duplicate_clusters — the old-deployment guard's sentence and per-key reach", () => {
  /** The whole operator-facing sentence, for the key that is absent. */
  const sentence = (key: string): string =>
    `The response has no \`${key}\` key although it was asked for: this SpecGuard deployment ` +
    "predates the bounded near-duplicate view and ignored the ask. Call this tool without " +
    "`summary` and `cluster` for the whole census, or upgrade the deployment.";

  it("states the whole refusal sentence and carries NO HTTP status (no HTTP failure occurred)", async () => {
    const http = stubFetch({ body: JSON.stringify({ near_duplicates: null }) });

    const error = (await rejects(
      nearDuplicateClusters.run({ summary: true }, toolContext({ env: ENV, fetch: http.fetch })),
      /near_duplicates_summary/,
    )) as Error & { status?: number };

    assert.equal(error.message, sentence("near_duplicates_summary"));
    assert.equal(error.status, undefined);
  });

  it("checks the SECOND asked key too: summary present, cluster absent still refuses naming the cluster key", async () => {
    const http = stubFetch({ body: JSON.stringify({ near_duplicates_summary: { cluster_count: 0 } }) });

    const error = await rejects(
      nearDuplicateClusters.run({ summary: true, cluster: 2 }, toolContext({ env: ENV, fetch: http.fetch })),
      /near_duplicate_cluster/,
    );

    assert.equal(error.message, sentence("near_duplicate_cluster"));
  });

  it("names the FIRST asked key (summary) when both asked keys are absent", async () => {
    const http = stubFetch({ body: JSON.stringify({ near_duplicates: null }) });

    const error = await rejects(
      nearDuplicateClusters.run({ summary: true, cluster: 2 }, toolContext({ env: ENV, fetch: http.fetch })),
      /^The response has no `near_duplicates_summary` key/,
    );

    assert.doesNotMatch(error.message, /no `near_duplicate_cluster` key/);
  });

  it("passes a PRESENT null for a lone cluster ask through unchanged (presence, not truthiness)", async () => {
    const body = { near_duplicate_cluster: null };
    const http = stubFetch({ body: JSON.stringify(body) });

    const result = await nearDuplicateClusters.run({ cluster: 2 }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.deepEqual(result.structured, body);
  });

  it("renders the bounded body as exactly 2-space-indented JSON", async () => {
    const body = { near_duplicate_cluster: { requested: 1 } };
    const http = stubFetch({ body: JSON.stringify(body) });

    const result = await nearDuplicateClusters.run({ cluster: 1 }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(result.text, JSON.stringify(body, null, 2));
    assert.equal(result.text, '{\n  "near_duplicate_cluster": {\n    "requested": 1\n  }\n}');
  });
});
