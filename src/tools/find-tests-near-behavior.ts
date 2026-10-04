import { ArgumentError } from "../errors.js";
import { getJsonObject, repositoryTarget } from "../support/specguard-api.js";
import { optionalString, requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repository?near=<behavior phrase>` as a tool — the bridge half
 * of roadmap SPGD-1102 ("Ask the suite map"), slice 3. The platform half
 * shipped first: `RequestedNearParam` guards the ask and `NearProbe` answers
 * it, behind the `near` block of `RepositoryOverview`, on both overview doors
 * (the singular `GET /api/v1/repository` under an `sgk_` key, the plural
 * `GET /api/v1/repositories/:id` under an agent or user key).
 *
 * == Why a SEPARATE tool, and not a parameter on `get_repository_overview`
 *
 * Every other ask on the overview is free or stored. This one is LIVE and
 * BILLED: a novel phrase costs one embedding call at the provider (a repeated
 * phrase is served from the embedding cache and buys nothing). An agent
 * calling the overview must never pay an embed by accident, and an agent
 * calling this tool has asked for nothing else — the same line
 * `near_duplicate_clusters` draws for the census, drawn here for a cost that
 * is per-call rather than per-ingest.
 *
 * == The phrase is sent trimmed, and a NUL is refused HERE
 *
 * `requireString` trims and refuses blank. The NUL refusal is the bridge's to
 * make, because the server's guard treats a NUL-containing, blank or
 * non-String `near` as NO ASK and answers the plain overview with `near:
 * null` — a 200 that would read, to an agent that sent a phrase, as an
 * answered ask. Refusing client-side keeps "asked, nothing came back" and
 * "never asked" from sharing one wire shape.
 *
 * == The response is passed through, not re-modelled
 *
 * Same rule as `near-duplicate-clusters.ts`. The `near` block's shape carries
 * distinctions the serializer spent care on — `ranked: null` (no ranking was
 * attempted: `provider_unconfigured` / `embedding_failed`) versus `ranked: []`
 * (the search ran and found nothing near), and, inside the latter,
 * `identity_count: 0` versus `identity_count > 0` with
 * `best_below_floor_similarity`. Coalescing any of them would turn three
 * different silences into one. The body goes back as it arrived.
 */
const findTestsNearBehavior: ToolDefinition = {
  name: "find_tests_near_behavior",

  title: "Find tests near a behavior",

  description:
    "Ask a repository's stored test suite map: which tests are nearest a behavior phrase you give it? " +
    "The server embeds your phrase and ranks the repository's stored test identities by similarity, " +
    "returning the top hits in the `near` block — each with its similarity, `signal_source`, last-known " +
    "path and the weight the latest run measured. " +
    "WHAT THE ANSWER IS NOT: it ranks STORED tests nearest the phrase and NEVER answers \"is this " +
    "already tested?\". It never gates a write and never issues a verdict — a hit near the phrase is not " +
    "coverage, and an empty answer is not proof of absence. `similarity_floor` is the near-duplicate " +
    "census's redundancy bar (how alike two tests must read for the census to pair them), NOT the 0.95 " +
    "matching threshold that decides whether two tests are the same test; do not read it as a pass mark. " +
    "READ `similarity_basis` AND `similarity_floor` BEFORE ANY FIGURE: a similarity without the statement " +
    "of what it measures is a confident number over nothing. " +
    "THE THREE SILENCES ARE DIFFERENT AND MUST NOT BE COLLAPSED: (1) `status` of `provider_unconfigured` " +
    "or `embedding_failed` with `ranked: null` — no ranking was attempted or the provider refused (an " +
    "`error` carries the provider's own reason); this says NOTHING about the suite. (2) `identity_count: " +
    "0` with `ranked: []` — the repository holds no identities, nothing has been ingested. (3) `ranked: " +
    "[]` with `identity_count` above zero and `best_below_floor_similarity` — identities exist and the " +
    "search ran, and none is near the phrase; the nearest one's similarity is served so that \"nothing " +
    "near\" is a finding you can check. `null` and `[]` are never interchangeable here. " +
    "`signal_sources` (the composition of the served page) and each hit's `signal_source` (whether the " +
    "hit matched on declared intent or on its name) are DIFFERENT EVIDENCE: a name match and an intent " +
    "match are not the same claim, so read the source before leaning on a hit. " +
    "COST: each NOVEL phrase costs ONE BILLED EMBEDDING CALL at the provider; repeating a phrase is " +
    "served from the cache and costs nothing (`cache_served` says which happened). The ask is LIVE — " +
    "computed on the request — unlike the stored census `near_duplicate_clusters` returns; it is its " +
    "own tool so that an overview call never pays an embed by accident. Send a considered phrase, not " +
    "a sweep of guesses. " +
    "`behavior` is REQUIRED: a behavior phrase in plain words (trimmed; blank is refused here before " +
    "any request, and so is a NUL character — the server would read it as no ask and answer the whole " +
    "overview with `near: null`, which would look like an answered ask). " +
    "WHICH repository is asked is optional: pass `repository` (a numeric id from `list_repositories`) " +
    "to ask that named repository under either member credential — the agent key preferred, the person " +
    "key when no agent key is set — or omit it to ask the repository the configured sgk_… key resolves " +
    "to. Same endpoints and credentials as `get_repository_overview`: without `repository`, an `sgk_` " +
    "repository key (SPECGUARD_API_KEY) on `GET /api/v1/repository`; with `repository`, EITHER member " +
    "credential on `GET /api/v1/repositories/:id` — SPECGUARD_AGENT_API_KEY (an sga_… agent key) " +
    "preferred, and, when that is not set, SPECGUARD_USER_API_KEY (an sgu_… person key); with both set " +
    "the agent key wins. The server owns the refusals on that path: a repository outside the presented " +
    "credential's grant answers 404, person and agent alike. " +
    "The response is the endpoint's full body with the `near` block OPENED, passed through unmodified — " +
    "with the one surface difference `get_repository_overview` documents for its own `repository` ask: " +
    "on the plural path the `api_key` block is ABSENT from the body rather than nulled.",

  inputSchema: {
    type: "object",
    properties: {
      behavior: {
        type: "string",
        description:
          "REQUIRED. The behavior phrase to look for — plain words describing what a test would " +
          "check, e.g. \"rejects an expired password reset token\". Trimmed and sent as `near`. " +
          "Blank or whitespace-only is refused before any request, and so is a phrase containing a " +
          "NUL character (U+0000): the server reads those shapes as no ask at all and would answer " +
          "the whole overview with `near: null`. NOTE: every NOVEL phrase costs one billed " +
          "embedding call; a repeated phrase is cache-served.",
      },
      repository: {
        type: "string",
        description:
          "Ask THIS repository instead of the one the configured sgk_… key resolves to. The " +
          "value is the repository's NUMERIC ID, exactly as served in `list_repositories` " +
          "entries' `id` — not the `org/repo` handle. " +
          "The credential changes with it: the call authenticates with EITHER member credential, " +
          "whichever is set — SPECGUARD_AGENT_API_KEY (an sga_… agent key; the set of " +
          "repositories granted onto it at mint time is the boundary the id is resolved " +
          "inside) and, when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key — a PERSON " +
          "key, whose accessible set is the boundary instead); with both set the agent key " +
          "wins. A repository outside the presented credential's grant answers 404, " +
          "indistinguishable from one that does not exist. " +
          "Omit it — or pass a blank — and the call is the singular one under SPECGUARD_API_KEY.",
      },
    },
    required: ["behavior"],
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    // Argument checks come FIRST, before config resolution or any request:
    // a malformed phrase must not cost a credential lookup, let alone a
    // billed embed.
    const behavior = requireString(args["behavior"], "behavior");
    if (behavior.includes("\u0000")) {
      throw new ArgumentError(
        "`behavior` must not contain a NUL (\\u0000) character: the server reads a NUL-containing " +
          "`near` as no ask and would answer the whole overview with `near: null`, which would look " +
          "like an answered ask. Remove the character and send the phrase again.",
      );
    }
    const repository = optionalString(args["repository"], "repository");
    const { api, path } = repositoryTarget(context.config, repository);

    const overview = await getJsonObject(api, path, { near: behavior }, context.fetch);

    return {
      text: JSON.stringify(overview, null, 2),
      structured: overview,
    };
  },
};

export default findTestsNearBehavior;
