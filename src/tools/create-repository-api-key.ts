import { postJsonObject, requireUserOrAgentApiConfig } from "../support/specguard-api.js";
import { optionalString, requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `POST /api/v1/repositories/:repository_id/api_keys` as a tool — shipped in
 * the platform (`specguard/config/routes.rb:158`,
 * `user_repository_api_keys_controller#create`, SPGD-754).
 *
 * == Reveal-once, again
 *
 * The 201 body carries `api_key.token` — the raw key, the only time it exists
 * anywhere — exactly as `add_repository`'s does. The body is therefore passed
 * through UNRESHAPED in both `text` and `structured` for the same reason that
 * tool states: any reshaping on this hop is a value that cannot be recovered
 * rather than a field that can be re-fetched. Recovery for a dropped token is
 * minting another key — this same tool — because the platform ships no
 * `#regenerate` and no re-serve.
 *
 * == The name is top-level and optional
 *
 * `params[:name]` defaults to `ApiKey::DEFAULT_NAME` server-side; `undefined`
 * here means "let the server name it" and simply omits the key from the POST
 * body. Not re-validated here for the reason `add_repository` states: a second
 * format rule on this side is a rule with no owner, free to drift from the one
 * that actually decides.
 */
const createRepositoryApiKey: ToolDefinition = {
  name: "create_repository_api_key",
  title: "Create repository API key",
  description:
    "Mints a new CI API key (an sgk_… key) for a SpecGuard repository, returning the new key " +
    "ALONE in an `api_key` block — the repository's full key set (keys minted in the web panel " +
    "or in an earlier session included) is `list_repository_api_keys`' answer, never this " +
    "response's. " +
    "⚠️ `api_key.token` is shown THIS ONCE AND NEVER AGAIN — nothing stores it and no " +
    "endpoint can re-serve it, so hand it to the user in your reply rather than assuming " +
    "it can be fetched later. If it is dropped, the recovery is minting another key with " +
    "this same tool (the platform has no regenerate), then revoking the orphaned one. " +
    "On success the response carries an `api_key` block (`id`, `name`, `token`, `hint`, " +
    "`created_at`) — the same reveal-once shape `add_repository` serves; `id` is the key's " +
    "durable handle (the token is reveal-once), and every OTHER key's id comes from " +
    "`list_repository_api_keys`. " +
    "Minting does not disturb existing keys: each key on a repository authenticates " +
    "independently until revoked. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports) and an optional " +
    "`name`, which the server defaults when omitted. " +
    "Authorization is the `keys_manage` capability — a member without it is refused 403 " +
    "in SpecGuard's own words. " +
    "It authenticates with EITHER of this server's two key-administration credentials, whichever " +
    "is set: SPECGUARD_AGENT_API_KEY (an sga_… key — the call then reaches only the repositories " +
    "granted onto that key at mint time, and only where the grant carries `keys.manage`; a " +
    "repository outside that set answers 404 in SpecGuard's own words, never a probe here) and, " +
    "when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key, the same credential " +
    "`add_repository` writes with). With both set the agent key wins, so the mint answers inside " +
    "the same set `list_repositories` reports. Minting under the agent credential attributes the " +
    "new key to the agent key's OWNER (the server's `attributed_user` rule), so minted-key counts " +
    "keep naming a person rather than nobody. " +
    "Either way it is a DIFFERENT credential from the sgk_… repository key " +
    "`get_repository_overview` uses; SpecGuard refuses each in the other's place.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository to mint the key for — its numeric id, as `add_repository` " +
          "returns and `list_repositories` reports, not the `org/repo` handle.",
      },
      name: {
        type: "string",
        description:
          "An optional label for the key. Omit it to let SpecGuard use its default name. " +
          "The server validates the name and refuses an unusable one in its own words.",
      },
    },
    required: ["repository_id"],
    // Closed for the reason every tool here states — and on a WRITE, a silently
    // dropped misspelled argument still mints something, just possibly mislabeled.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const name = optionalString(args["name"], "name");

    const api = requireUserOrAgentApiConfig(context.config);

    // `name` omitted when absent rather than sent as null, so the server's own
    // `ApiKey::DEFAULT_NAME` default applies — this bridge expresses "no
    // preference", it does not choose on the server's behalf.
    const created = await postJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/api_keys`,
      name === undefined ? {} : { name },
      context.fetch,
    );

    // Unreshaped, for the reason `add_repository` states at its own return:
    // `api_key.token` exists nowhere else, so any reshaping on this hop is a
    // value that cannot be recovered.
    return {
      text: JSON.stringify(created, null, 2),
      structured: created,
    };
  },
};

export default createRepositoryApiKey;
