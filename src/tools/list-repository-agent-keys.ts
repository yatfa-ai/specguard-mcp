import { getJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repositories/:repository_id/agent_keys` as a tool — shipped in
 * the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryAgentKeysController#index`, SPGD-1004, `dfb9892`).
 *
 * == The id source is THIS listing, and only this listing
 *
 * Agent keys have no mint tool on this bridge — deliberately: the platform
 * mints them web-only at /account (the controller header states the rule), so
 * unlike `sgk_` keys there is no create response to read an id from. The `id`
 * each row serves is therefore the ONLY way an agent can name an agent key to
 * `revoke_repository_agent_key`, and the description says so rather than
 * leaving it implicit — an agent that arrives needing to cut a key without
 * having listed first has no fallback path.
 *
 * == Rows, pass-through
 *
 * The endpoint answers `{agent_keys: [...]}`, one row per LIVE key covering
 * this repository: `id`, `name`, `owner`, `token_hint`, `repository_count`
 * (the size of the key's stored set — the blast radius a revoke would land
 * on), `permissions` (rendered the way the web panel renders it, "read only"
 * for the minimal grant) and `created_at`. `token_hint` is a hint and never
 * the token: the plaintext existed for exactly one response at mint time and
 * nothing persisted it. Revoked rows leave the listing — a retained revoked
 * row is not a credential — and the still-presented triage over those rows is
 * `list_repository_agent_keys_presented_revoked`.
 *
 * == No client-side capability probing
 *
 * The server gates at `current_repository(:keys_manage)`, the same gate the
 * `sgk_` key pair answers to: a caller who cannot administer this
 * repository's keys is refused 403 in SpecGuard's own words, and a caller who
 * cannot see the repository at all gets the nil-is-404 fork. This tool
 * predicts neither; it reports what came back.
 */
const listRepositoryAgentKeys: ToolDefinition = {
  name: "list_repository_agent_keys",
  title: "List repository agent keys",
  description:
    "Lists the agent keys (`sga_…` keys) covering a SpecGuard repository: one row per live key " +
    "with its `id`, `name`, `owner`, `token_hint`, `repository_count` (how many repositories the " +
    "key's grant covers — the blast radius), `permissions` and `created_at`. " +
    "Agent keys have NO mint tool on this bridge — minting is deliberately web-only — so the `id` " +
    "this listing serves is the ONLY way to name a key to `revoke_repository_agent_key`: list " +
    "first, then revoke. " +
    "Revoked keys leave this listing (a retained revoked row is not a credential); whether a dead " +
    "token is still arriving is `list_repository_agent_keys_presented_revoked`'s question. " +
    "`token_hint` is a hint, never the token — the plaintext existed for exactly one response at " +
    "mint time and nothing persisted it. " +
    "Authorization is the `keys_manage` capability — a caller without it is refused 403 in " +
    "SpecGuard's own words. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports, not the `org/repo` handle). " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential the other key-administration " +
    "tools read and a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository whose agent keys to list — its numeric id, as `add_repository` " +
          "returns and `list_repositories` reports, not the `org/repo` handle.",
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

    const api = requireUserApiConfig(context.config);

    const body = await getJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/agent_keys`,
      {},
      context.fetch,
    );

    // Passed through unreshaped, the standing rule (`types.ts`: "A thin client
    // that reshapes its upstream is not thin") — the rows are the controller's
    // own serialization, and the `id` an agent needs for the revoke is one of
    // the fields a reshape could drop.
    return {
      text: JSON.stringify(body, null, 2),
      structured: body,
    };
  },
};

export default listRepositoryAgentKeys;
