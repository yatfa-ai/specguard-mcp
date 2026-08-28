import { requireApiConfig } from "../config.js";
import { getJsonObject } from "../support/specguard-api.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repository?near_duplicates=` as a tool — shipped in the
 * platform by SPGD-703 (`specguard` `c43dc19`, 2026-08-28), which added the
 * `near_duplicates` block to `RepositoryOverview` behind an opt-in ask.
 *
 * == What the block is, and why it is behind an ask at all
 *
 * It is the suite-wide near-duplicate census: which tests READ alike — same
 * body text, not same file — clustered by the engine SPGD-369 shipped
 * (`specguard` `f7d5352`). It is the first block on that endpoint whose grain
 * is the REPOSITORY rather than a run or a window of runs, and the first one
 * gated on COST rather than rows: `NearDuplicateClusters` is linear but
 * measured in seconds (seven queries at every size; seconds at a few thousand
 * identities, extrapolating to tens of seconds at the 20,000-identity design
 * point). `?near_duplicates=` confines that cost to the client that named it —
 * no ask, key present and `null`, not one query — which is why this block is a
 * SEPARATE tool rather than a forwarded parameter on
 * `get_repository_overview`: an agent calling the overview should never pay
 * the census by accident, and an agent calling this tool has asked for nothing
 * else. Splitting the tools splits the cost along exactly the line the server
 * drew.
 *
 * == The ask is always sent, and always spelled `"true"`
 *
 * The server reads only whether the parameter is PRESENT
 * (`RequestedNearDuplicatesParam`): `?near_duplicates=false` opens the block
 * exactly as `=true` does, and a non-String shape is read as no ask at all.
 * There is no "off" value for a client to send, so this tool has no arguments
 * — nothing about the census is choosable from here, which is also why the
 * schema is CLOSED rather than merely empty: `server.ts` forwards `arguments`
 * unvalidated, and an open schema would let an invented argument ride through
 * and be silently dropped (see `registrable-repositories.ts` for the same
 * call). `near_duplicates: "true"` is built rather than stringified for the
 * same reason `repository-overview.ts` builds its `unannotated_examples` key:
 * `getJson` omits only `undefined`, so a conditional send is the only honest
 * way to spell "always" here.
 *
 * == The response is passed through, not re-modelled
 *
 * Same rule as `repository-overview.ts`: every figure in the block is
 * annotated in `RepositoryOverview#serialized_near_duplicates` with the reason
 * for its shape, and several of those reasons are about honesty rather than
 * convenience — `similarity_floor`/`similarity_basis` served FIRST because a
 * count without the statement of what the similarity means is a vacuous
 * figure; `member_count` (texts in the REPOSITORY, across every run) and
 * `example_count` (examples in the ONE run `weighed_run_id` names) served side
 * by side because a three-example table-driven loop is one member and three
 * examples, and flattening them would erase the figure the ranking is built
 * on; `unobserved_members` disclosing that the member list holds an identity
 * the weighed run did not observe; `similarity_range` as the `[strongest,
 * weakest]` pair because membership is transitive while similarity is not.
 * Reshaping here would discard distinctions the serializer spent that care
 * preserving, so the body goes back as it arrived — the whole body, which
 * carries the repository/run context the clusters sit inside.
 */
const nearDuplicateClusters: ToolDefinition = {
  name: "near_duplicate_clusters",

  title: "Near-duplicate clusters",

  description:
    "Run SpecGuard's near-duplicate census over a repository's tests — which tests READ alike " +
    "(same body text, whatever file they sit in), clustered by similarity. Answers the refactoring " +
    "question the overview's per-run rankings cannot: where is the same test written twice, before " +
    "you delete or merge anything. " +
    "THIS IS THE EXPENSIVE READ ON THIS BRIDGE: the census is linear but measured in seconds — seven " +
    "queries at every size, tens of seconds extrapolated at the 20,000-test design point — which is " +
    "exactly why the server serves it only to a client that asks (`?near_duplicates=`) and answers " +
    "`near_duplicates: null` on the plain overview. Calling this tool IS the ask; it takes no " +
    "arguments because nothing about the census is choosable — the clusters are the repository's, " +
    "computed over every run, and one call returns them all. " +
    "READ THE DISCLOSURE KEYS BEFORE THE COUNT: `similarity_floor` and `similarity_basis` sit FIRST " +
    "in the block and qualify every cluster below them — a cluster count without what 'similar' " +
    "meant is a figure you cannot act on. `truncated: true` means the cluster list was cut at the " +
    "cap while the counts above it (`cluster_count`, `identity_count`, `clustered_*`) describe the " +
    "WHOLE census, so never fold `clusters` length as the total. " +
    "READ EVERY CLUSTER'S FIGURES AT THEIR OWN GRAIN: `member_count` counts texts in the REPOSITORY " +
    "across every run, `example_count` counts examples in the ONE run `weighed_run_id` names — a " +
    "three-example table-driven loop is ONE member and THREE examples, and those two numbers beside " +
    "each other are the whole point. `unobserved_members: true` on a cluster says a member identity " +
    "the weighed run did not observe (deleted, renamed, deselected) is still listed — do not reconcile " +
    "the member list against a run's examples and expect it to balance. `similarity_range` is " +
    "[strongest, weakest]: membership is transitive, similarity is not, and the gap between the edges " +
    "is the merge risk. `total_seconds` is raw and `null` where nothing was timed — never a zero " +
    "that would read as free. " +
    "A quiet answer is a FINDING, not a gap: `clusters: []` with a real `identity_count` is the " +
    "success state (nothing reads alike), and the three silences — nothing ingested " +
    "(`recorded_count: 0`), nothing embedded (`identity_count: 0`), nothing alike — are kept " +
    "distinguishable by those counts rather than collapsed into one empty list. " +
    "Same credential and endpoint as `get_repository_overview` (an `sgk_` repository key on " +
    "`GET /api/v1/repository`); the response is that endpoint's full body with the `near_duplicates` " +
    "block OPENED, passed through unmodified.",

  inputSchema: {
    type: "object",
    // No properties, deliberately — see this file's header. Still CLOSED rather
    // than merely empty, for the reason `registrable-repositories.ts` gives
    // inline: `server.ts` forwards `arguments` unvalidated and `run` ignores
    // them, so an open schema would have an invented argument silently dropped
    // and the call answered as if it had been honoured.
    additionalProperties: false,
  },

  async run(_args, context): Promise<ToolResult> {
    const api = requireApiConfig(context.config);

    const overview = await getJsonObject(
      api,
      "/api/v1/repository",
      {
        // Always sent, always `"true"` — the server reads only that the key is
        // present (`?near_duplicates=false` opens the block too), and this
        // tool exists to open it. See this file's header.
        near_duplicates: "true",
      },
      context.fetch,
    );

    return {
      text: JSON.stringify(overview, null, 2),
      structured: overview,
    };
  },
};

export default nearDuplicateClusters;
