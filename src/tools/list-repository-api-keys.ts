import { getJsonObject, requireUserOrAgentApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repositories/:repository_id/api_keys` as a tool — shipped in
 * the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryApiKeysController#index`, SPGD-993).
 *
 * == The verify step of the rotation this bridge otherwise cannot see
 *
 * The README prescribes the `sgk_` rotation — mint a replacement with
 * `create_repository_api_key`, deploy it, THEN revoke the old one — but until
 * this tool the bridge could not answer the question the middle step turns
 * on: has the replacement presented itself? The mint response is
 * point-in-time by construction (an `api_key` block describing only the new
 * key; usage accrues after it), and the one other read that touches keys,
 * `get_repository_overview`, serves findings only — its `credential_health`
 * is stranded + presented-revoked, and a replacement that never presented is
 * neither. Revoking first would lock the repository's CI out until a human
 * mints in a browser, so the listing is the check to run BEFORE the cut.
 *
 * == The id source for every row this session did not mint
 *
 * `revoke_repository_api_key`'s `key_id` is documented as coming from
 * `add_repository`'s or `create_repository_api_key`'s response — i.e. keys
 * this session minted. A key minted by a person in the panel, or in an
 * earlier session, has no bridge-learnable id except through this listing.
 * The mint response does carry the id of the key IT minted (SPGD-993); this
 * listing is the id source for every OTHER row.
 *
 * == Rows, pass-through
 *
 * The endpoint answers `{api_keys: [...]}` over the repository's key set —
 * LIVE AND REVOKED rows alike, unlike the `sga_` listing
 * (`list_repository_agent_keys`), which deliberately serves live rows only.
 * A revoked `sgk_` row is not a credential either, but the rotation's story
 * lives in the population: `status` (`live`/`revoked`, with `revoked_at`
 * present only on revoked rows) is what tells a replacement apart from its
 * predecessor. Each row serves the controller's own serialization: `id`,
 * `name`, `token_hint`, `created_at`, `created_by`, `last_used_at`
 * (null meaning the key has NEVER presented — the negative is served, not
 * omitted), `rotated_at` (null until `regenerate!` retired a token), and
 * `rotated_and_unused` (live-scoped — the stranded shape `credential_health`
 * reports, served here at row grain). `token_hint` is a hint and never the
 * token: the plaintext existed for exactly one response at mint time and
 * nothing persisted it. Passed through UNRESHAPED — the rows are the
 * controller's own serialization, and reshaping is how a field the revoke
 * needs gets dropped.
 *
 * == No client-side capability probing
 *
 * The server gates at `current_repository(:keys_manage)` — the same gate the
 * create/revoke pair answers to. A caller without `keys_manage` is refused
 * 403 in SpecGuard's own words; a repository outside the credential's reach
 * answers the nil-is-404 fork. This tool predicts neither; it reports what
 * came back.
 */
const listRepositoryApiKeys: ToolDefinition = {
  name: "list_repository_api_keys",
  title: "List repository API keys",
  description:
    "Lists a SpecGuard repository's CI API keys (`sgk_…` keys) — the verify step of the " +
    "mint-and-replace rotation. After minting a replacement with `create_repository_api_key` " +
    "and deploying it, list HERE and check the replacement's `last_used_at` before revoking the " +
    "old key: `null` means the new token has not presented itself yet, and cutting the old key " +
    "then locks the repository's CI out until a human mints in a browser. " +
    "The mint response carries the id of the key IT minted (in its `api_key` block); THIS " +
    "listing is the id source for every other row — keys minted in the web panel or in an " +
    "earlier session have no other bridge-learnable id, so list here to name a `key_id` for " +
    "`revoke_repository_api_key`. " +
    "The population is LIVE AND REVOKED rows alike — `status` (`live`/`revoked`), with " +
    "`revoked_at` present only on revoked rows — a deliberate contrast with the `sga_` listing " +
    "`list_repository_agent_keys`, which serves live rows only: a revoked `sgk_` row is not a " +
    "credential either, but the rotation's story lives in the population. Each row serves " +
    "`id`, `name`, `token_hint`, `created_at`, `created_by`, `last_used_at` (null meaning the " +
    "key has never presented), `rotated_at`, and `rotated_and_unused` — the stranded shape " +
    "`get_repository_overview`'s `credential_health` reports, at row grain. " +
    "`token_hint` is a hint, never the token — the plaintext existed for exactly one response " +
    "at mint time and nothing persisted it. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports, not the `org/repo` handle). " +
    "It authenticates with EITHER of this server's two key-administration credentials, whichever " +
    "is set: SPECGUARD_AGENT_API_KEY (an sga_… key — the call then reaches only the repositories " +
    "granted onto that key at mint time, and only where the grant carries `keys.manage`; a caller " +
    "without that capability is refused 403 in SpecGuard's own words, and a repository outside " +
    "the credential's reach answers 404 — this tool predicts neither) and, " +
    "when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key, the same credential the other " +
    "key-administration tools read). With both set the agent key wins, so the answer stays " +
    "inside the same set `list_repositories` reports. " +
    "Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` " +
    "uses; SpecGuard refuses each in the other's place.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository whose API keys to list — its numeric id, as `add_repository` " +
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

    const api = requireUserOrAgentApiConfig(context.config);

    const body = await getJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/api_keys`,
      {},
      context.fetch,
    );

    // Passed through unreshaped, the standing rule (`types.ts`: "A thin client
    // that reshapes its upstream is not thin") — the rows are the controller's
    // own serialization, and the `id` the revoke needs on a key this session
    // did not mint is one of the fields a reshape could drop.
    return {
      text: JSON.stringify(body, null, 2),
      structured: body,
    };
  },
};

export default listRepositoryApiKeys;
