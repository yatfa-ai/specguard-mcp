import { getJsonObject, requireUserOrAgentApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repositories/:repository_id/agent_keys/presented_revoked` as a
 * tool — shipped in the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryAgentKeysController#presented_revoked`, SPGD-1023,
 * `533e77b`).
 *
 * == The verify half of the offboarding arc
 *
 * The listing and the revoke answer "what is live" and "cut this one"; neither
 * can answer the question a revoker is left holding — "is the dead token still
 * arriving?" — because both read LIVE rows only. The stamp this triage serves,
 * `last_refused_at`, is written by the 401 failure path on RETAINED revoked
 * rows, so it cannot ride a live row at all. This read is the bridge's only
 * window onto it, behind the same `keys_manage` gate the other two actions
 * answer to.
 *
 * == Two honesty clauses the description carries verbatim
 *
 * `last_refused_at` is the LAST observed presentation — a recency, never a
 * present-tense claim that a client is presenting the token now. And an empty
 * `{"agent_keys": []}` is an ANSWER — "no revoked key is still being
 * presented" — not an absence of tracking; the endpoint serves the negative
 * deliberately so the two are distinguishable. A tool that summarised an
 * empty answer into a count of its own would erase exactly that distinction,
 * which is why this one passes the body through.
 *
 * == Rows, pass-through
 *
 * One row per still-presented revoked key covering this repository: `id`,
 * `name`, `owner`, `token_hint`, `repository_count` (the STORED set's size —
 * the same blast-radius figure the revoke response discloses), `revoked_at`
 * and `last_refused_at`. `token_hint` is what the remedy hunts for in the
 * secret store — update whichever of them still holds the dead token — and it
 * is never the token: the plaintext existed for exactly one response at mint
 * time and nothing persisted it.
 */
const listRepositoryAgentKeysPresentedRevoked: ToolDefinition = {
  name: "list_repository_agent_keys_presented_revoked",
  title: "List still-presented revoked agent keys",
  description:
    "Lists REVOKED agent keys whose token is still arriving at the deployment after revocation — " +
    "the verify half of offboarding: run it after `revoke_repository_agent_key` to learn whether " +
    "the dead token is still being presented somewhere. Each row carries `id`, `name`, `owner`, " +
    "`token_hint` (hunt THIS in whatever secret stores may still hold the dead token, and update " +
    "them), `repository_count`, `revoked_at` and `last_refused_at`. " +
    "`last_refused_at` is the LAST observed presentation — a recency, never a present-tense claim " +
    "that something is presenting the token right now. " +
    "An empty `{\"agent_keys\": []}` is an ANSWER — nothing is still arriving — not an absence of " +
    "tracking; read it as the offboarding having fully taken. " +
    "`token_hint` is a hint, never the token — the plaintext existed for exactly one response at " +
    "mint time and nothing persisted it. " +
    "Authorization is the `keys_manage` capability — a caller without it is refused 403 in " +
    "SpecGuard's own words. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports, not the `org/repo` handle). " +
    "It authenticates with EITHER of this server's two key-administration credentials, whichever " +
    "is set: SPECGUARD_AGENT_API_KEY (an sga_… key — the call then reaches only the repositories " +
    "granted onto that key at mint time, and only where the grant carries `keys.manage`; a " +
    "repository outside that set answers 404 in SpecGuard's own words, never a probe here — an " +
    "agent credential verifying its own offboarding needs no person's `sgu_` key to do it) and, " +
    "when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key, the same credential the other " +
    "key-administration tools read). With both set the agent key wins, so the triage stays inside " +
    "the same set `list_repositories` reports. " +
    "Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` " +
    "uses; SpecGuard refuses each in the other's place.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository to triage — its numeric id, as `add_repository` returns and " +
          "`list_repositories` reports, not the `org/repo` handle.",
      },
    },
    required: ["repository_id"],
    // Closed for the reason every tool here states: `server.ts` forwards
    // `arguments` unvalidated, so an open schema would let a misspelled argument
    // be dropped silently.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");

    const api = requireUserOrAgentApiConfig(context.config);

    const body = await getJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/agent_keys/presented_revoked`,
      {},
      context.fetch,
    );

    // Passed through unreshaped, the standing rule (`types.ts`: "A thin client
    // that reshapes its upstream is not thin") — and the empty answer passes
    // through with it: `{"agent_keys": []}` is the endpoint saying "nothing is
    // still arriving", and a summary of it would erase the distinction between
    // that answer and an absence of tracking.
    return {
      text: JSON.stringify(body, null, 2),
      structured: body,
    };
  },
};

export default listRepositoryAgentKeysPresentedRevoked;
