import { ApiError } from "../errors.js";
import { getJsonObject, repositoryTarget } from "../support/specguard-api.js";
import { optionalBoolean, optionalPositiveInteger, optionalString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repository?near_duplicates=` as a tool — shipped in the
 * platform by SPGD-703 (`specguard` `c43dc19`, 2026-08-28), which added the
 * `near_duplicates` block to `RepositoryOverview` behind an opt-in ask.
 *
 * == What the block is, and why it is behind an ask at all (this section is
 * the pre-SPGD-1474 story — the cost was live on the request; the next section
 * is what changed)
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
 * == SPGD-1474: the census is computed at ingest, and this read is stored
 *
 * The minutes-scale compute no longer sits behind the request (and could never
 * fit this bridge's 30-second default deadline). The server computes the census
 * once per write that moves its inputs — at each ingest, after identity
 * resolution settles the run's identities, and again when a run is deleted from
 * the repository (which can move the run the weight figures are weighed on) —
 * persists it, and serves the stored artifact, so a call here costs one stored
 * read and returns in milliseconds. The opt-in ask is unchanged wire contract
 * (`?near_duplicates=` still opens the block; the plain overview still answers
 * `null` without it), and the tool split still stands: one call, one census,
 * no accidental cost. What changed is the latency story and the honesty
 * machinery around it: the block carries `computed_at` (when the stored
 * artifact was taken) and `weighed_run_id` (which run its weight figures are
 * from), so a consumer can always tell how fresh the census it is reading is.
 * A request arriving between a completed write and the finished recompute
 * serves the PREVIOUS stored census with its own stamp — never a live
 * computation, never an unstamped answer. Between those writes (an ingest, or a
 * run deletion) the stored census is exactly what a live computation would
 * return: the inputs change only there.
 *
 * == The default ask is always sent, and always spelled `"true"`
 *
 * The server reads only whether the parameter is PRESENT
 * (`RequestedNearDuplicatesParam`): `?near_duplicates=false` opens the block
 * exactly as `=true` does, and a non-String shape is read as no ask at all.
 * There is no "off" value for a client to send, so a call with no `summary`
 * and no `cluster` sends `near_duplicates=true` and gets the whole census.
 * What IS choosable is WHICH REPOSITORY is censused (SPGD-953): an optional
 * `repository` argument (a numeric id from `list_repositories`) moves the call
 * to the plural endpoint `GET /api/v1/repositories/:id` under either member
 * credential, whichever is set — the AGENT key preferred, and the USER key (a
 * person credential, whose accessible set is the boundary the id is resolved
 * inside) when no agent key is set; SPGD-1106 widened the plural arm from
 * agent-only, on the same agent-wins/user-fallback terms every
 * either-credential tool answers by. Same body (minus the `api_key` block,
 * which is ABSENT on that surface rather than nulled — see
 * `repository-overview.ts` for why the omission is the server's, deliberately),
 * same ask, same cost gate. Without it the request is byte-for-byte the
 * singular, `sgk_`-bound one this tool has always made — and the cost argument
 * above is exactly why the argument is OPTIONAL rather than required: an agent
 * that has only ever had one reachable repository should not be asked to learn
 * a second credential to keep reading it.
 *
 * == SPGD-1714: the bounded view (`summary`, `cluster`)
 *
 * The platform half (SPGD-1712) serves two further asks on the same endpoints:
 * `?near_duplicates_summary=` (the ranking, head keys first, no member lists)
 * and `?near_duplicate_cluster=<rank>` (ONE cluster, members once). Like the
 * default ask, the server reads only that the summary key is PRESENT, so
 * `summary: false` sends NOTHING rather than `=false` — "off" is spelled by
 * omission. When either bounded ask is made, ONLY the asks named are sent (not
 * also `near_duplicates=true`: that would open the whole census beside the
 * bounded view the caller chose it to avoid). `cluster` is not range-checked
 * here: an out-of-range rank is the server's to answer (a `null` cluster with
 * the ask echoed).
 *
 * Because a deployment that predates SPGD-1712 would silently ignore an
 * unknown parameter and answer 200 with the plain overview, an ask whose
 * matching key is ABSENT from the body (absent, not `null` — a present `null`
 * is the server's own "asked, nothing there") is turned into an error naming
 * the key. Otherwise "asked for the bounded view, got nothing" and "the
 * deployment ignored the ask" would share one wire shape. Nothing else is
 * inspected: the tool stays a pass-through.
 *
 * Every key is built conditionally rather than stringified for the same
 * reason `repository-overview.ts` builds its `unannotated_examples` key:
 * `getJson` omits only `undefined`, so a conditional send is the only honest
 * way to spell "only when asked". The schema stays CLOSED around its arguments:
 * `server.ts` forwards `arguments` unvalidated, and an open schema would let an
 * invented argument ride through and be silently dropped (see
 * `registrable-repositories.ts` for the same call).
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
    "This call is SERVED STORED: the server computes the census at each ingest and on each run " +
    "deletion and keeps it, so the " +
    "answer returns in milliseconds instead of running the minutes-scale computation that used to " +
    "sit behind the ask (and never fit this bridge's 30-second deadline). READ THE STAMP: " +
    "`computed_at` is when the stored artifact was taken and `weighed_run_id` is the run its weight " +
    "figures are from — a census read shortly after an ingest or a run deletion may be the PREVIOUS " +
    "artifact, stamped, " +
    "while the recompute runs; between such writes the stored census is exactly what a live computation " +
    "would return. The opt-in ask is unchanged wire contract: the server answers `near_duplicates: " +
    "null` on the plain overview (no ask, not one query), and `null` ON THIS TOOL means no census has " +
    "been computed for the repository yet — a repository that has never ingested, read in the window " +
    "before its first computation lands. It is never a live computation and never zeros: a repository " +
    "whose every test reads differently serves a stored block with `clusters: []` and real counts. " +
    "Calling this tool IS the ask; by default one call returns the whole census — the clusters are " +
    "the repository's, computed over every run. Two optional arguments bound the view instead (below). " +
    "WHICH repository is censused: pass `repository` " +
    "(a numeric id from `list_repositories`) to census that named repository under either member " +
    "credential — the agent key preferred, the person key when no agent key is set — or omit it to " +
    "census the repository the configured sgk_… key resolves to, exactly as before the argument " +
    "existed. " +
    "THE BOUNDED VIEW — START WITH `summary`, DRILL IN WITH `cluster`: the default call serves every " +
    "cluster with its full member list, which on a large suite is a large body. `summary: true` asks " +
    "for `near_duplicates_summary` instead: the ranking with the head keys first and, per cluster, " +
    "`rank`, `files_seen`, `file_count` and `declared_layers` — and NO member lists. Then pass " +
    "`cluster: <rank>` to ask for `near_duplicate_cluster`: ONE cluster, members once, carrying " +
    "`requested` (the rank you asked for, echoed), `rank`, `cluster_count`, `weighed_run_id`, " +
    "`computed_at`, `member_listing` (`members` or `layer_groups` — which of the two member shapes " +
    "the `cluster` carries) and `cluster` itself. When either argument is supplied ONLY the asks " +
    "named are sent — the whole-census `near_duplicates` block is not also opened; send both and you " +
    "get both keys. RANKS ARE POSITIONS IN A SNAPSHOT: read `computed_at` before reusing a rank, " +
    "because an ingest or a run deletion recomputes the census and the same rank can then name a " +
    "different cluster. A rank beyond `cluster_count` is not an error: the key is present with " +
    "`cluster: null` and `requested` echoing your ask. A deployment that predates the bounded view " +
    "ignores the ask; this tool then fails naming the missing key rather than returning a body that " +
    "silently lacks it. " +
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
    "READ THE LAYER CUT AS DECLARATIONS, NEVER AS A GUESS: `layer_source` at the head of the block " +
    "states where the layer dimension comes from — it is 'declared via the intent protocol' when at " +
    "least one clustered member's examples declared a layer, and `null` on a suite that declared " +
    "nothing, which is absence STATED, not an empty grouping to read as a finding. Each cluster " +
    "carries `layer_redundancy` — `cross_layer` when its members declared two or more DISTINCT " +
    "layers (the same behaviour covered on several levels: the test-pyramid question), `same_layer` " +
    "when confined to one (a plain duplicate), `null` when its members declared nothing, which is " +
    "neither and must not be folded into `same_layer` — and `layer_groups`, the members grouped by " +
    "the layer their examples declared, alphabetically, with the undeclared LAST as the " +
    "`layer: null` group. No path or directory convention is consulted anywhere in the cut: a " +
    "`request`-declared test living under spec/models is reported `request`, because declarations " +
    "do not lie and paths do. A member whose own examples declared two layers appears in EACH group " +
    "it declared — so the groups' sizes can exceed `member_count` by exactly those members, which " +
    "is the finding, not an arithmetic bug — and a member that declared nothing stays in its " +
    "cluster's null group, never dropped. " +
    "A quiet answer is a FINDING, not a gap: `clusters: []` with a real `identity_count` is the " +
    "success state (nothing reads alike), and the three silences — nothing ingested " +
    "(`recorded_count: 0`), nothing embedded (`identity_count: 0`), nothing alike — are kept " +
    "distinguishable by those counts rather than collapsed into one empty list. " +
    "Same endpoints and credentials as `get_repository_overview`: without `repository`, an " +
    "`sgk_` repository key on `GET /api/v1/repository`; with `repository`, EITHER member " +
    "credential, whichever is set, on `GET /api/v1/repositories/:id` — SPECGUARD_AGENT_API_KEY " +
    "(an sga_… agent key, whose mint-time granted repository set bounds the answer) preferred, " +
    "and, when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key — a PERSON key, whose " +
    "accessible set bounds the answer instead); with both set the agent key wins. The server " +
    "owns the refusals on that path: a repository outside the presented credential's grant " +
    "answers 404, person and agent alike. " +
    "The response is the endpoint's full body with the asked-for block OPENED (`near_duplicates` by " +
    "default), passed " +
    "through unmodified — with the one surface difference `get_repository_overview` documents " +
    "for its own `repository` ask: on that plural path the `api_key` block is ABSENT from the " +
    "body rather than nulled (it describes the credential that made the request, and no member " +
    "credential is a repository key), so an absent `api_key` there is the surface's shape, never " +
    "a dropped block.",

  inputSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description:
          "Census THIS repository instead of the one the configured sgk_… key resolves to. The " +
          "value is the repository's NUMERIC ID, exactly as served in `list_repositories` " +
          "entries' `id` — not the `org/repo` handle. " +
          "The credential changes with it: the call authenticates with EITHER member credential, " +
          "whichever is set — SPECGUARD_AGENT_API_KEY (an sga_… agent key; the set of " +
          "repositories granted onto it at mint time is the boundary the id is resolved " +
          "inside) and, when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key — a PERSON " +
          "key, whose accessible set is the boundary instead); with both set the agent key " +
          "wins. The server owns the refusals on that path: a repository outside the " +
          "presented credential's grant answers 404, indistinguishable from one that does " +
          "not exist — person and agent alike. The census itself is identical on " +
          "either path: same block, same caps, same disclosure keys. " +
          "Omit it — or pass a blank — and the call is byte-for-byte the singular one under " +
          "SPECGUARD_API_KEY, exactly as before this argument existed.",
      },
      summary: {
        type: "boolean",
        description:
          "Ask for the BOUNDED census view: the `near_duplicates_summary` block — the ranking " +
          "(head keys first; per cluster `rank`, `files_seen`, `file_count`, `declared_layers`) with " +
          "NO member lists — instead of the whole census. `true` sends the ask; `false` or omitted " +
          "sends nothing (the server treats any value as an ask, so `false` is never put on the " +
          "wire). When supplied it REPLACES the default `near_duplicates` ask. Start here, then " +
          "drill in with `cluster`.",
      },
      cluster: {
        type: "integer",
        minimum: 1,
        description:
          "Ask for ONE cluster by its `rank` in the ranking (1-based): the " +
          "`near_duplicate_cluster` block, members listed once. Take the rank from a `summary` " +
          "call and read `computed_at` first — ranks are positions in a snapshot and shift when " +
          "the census is recomputed. Not range-checked here: a rank past `cluster_count` is " +
          "answered by the server with `cluster: null` and the ask echoed. When supplied it " +
          "REPLACES the default `near_duplicates` ask; send it with `summary: true` to get both " +
          "blocks.",
      },
    },
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    // Argument shapes are checked FIRST, before any config is resolved or
    // request made — the class of fault the agent can fix from the message.
    const repository = optionalString(args["repository"], "repository");
    const summary = optionalBoolean(args["summary"], "summary");
    const cluster = optionalPositiveInteger(args["cluster"], "cluster");

    // Only the asks NAMED are sent. With neither bounded ask this is exactly
    // the request this tool has always made. `summary: false` is NO ask — the
    // server reads only that the key is present, so `=false` would open it.
    const asks: Record<string, string> = {};
    if (summary === true) asks["near_duplicates_summary"] = "true";
    if (cluster !== undefined) asks["near_duplicate_cluster"] = String(cluster);
    const bounded = Object.keys(asks).length > 0;
    // Always `"true"` on the default path — the server reads only that the key
    // is present. See this file's header.
    const query = bounded ? asks : { near_duplicates: "true" };

    // WHICH ENDPOINT AND WHICH CREDENTIAL is one branch point over the one
    // ask, and it is spelled once in `repositoryTarget`
    // (`../support/specguard-api.js`): the pair (path, credential) must not
    // be mixable, because either mixed pairing is a 401 at the deployment by
    // design and both are refused there, legibly, instead. This site only
    // decides what it asks — no repository named means the singular census,
    // a name means the plural one under either member credential (SPGD-1106).
    const { api, path } = repositoryTarget(context.config, repository);

    const overview = await getJsonObject(api, path, query, context.fetch);

    // Old-server guard: an unknown parameter is silently ignored, so an ask
    // whose key is ABSENT (not `null`) means the deployment predates it.
    for (const key of Object.keys(asks)) {
      if (!(key in overview)) {
        throw new ApiError(
          `The response has no \`${key}\` key although it was asked for: this SpecGuard deployment ` +
            "predates the bounded near-duplicate view and ignored the ask. Call this tool without " +
            "`summary` and `cluster` for the whole census, or upgrade the deployment.",
        );
      }
    }

    return {
      text: JSON.stringify(overview, null, 2),
      structured: overview,
    };
  },
};

export default nearDuplicateClusters;
