import assert from "node:assert/strict";
import { describe, it } from "node:test";

import getRepositoryOverview from "../../src/tools/repository-overview.js";
import nearDuplicateClusters from "../../src/tools/near-duplicate-clusters.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

const ENV = { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

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
