import { deleteJson, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `DELETE /api/v1/repositories/:repository_id/api_keys/:id` as a tool —
 * shipped in the platform (`specguard/config/routes.rb:159`,
 * `user_repository_api_keys_controller#destroy`, SPGD-754).
 *
 * == Replacement-mint-then-revoke is the rotation model
 *
 * The platform ships no `#regenerate`. Rotating a compromised key is therefore
 * two calls with tools this slice lands together: mint a replacement
 * (`create_repository_api_key`), deploy it, then revoke the old one here. That
 * ordering is stated in the description because it is the one thing an agent
 * must know before it revokes — revoke-first locks the repository's CI out
 * until a human intervenes.
 *
 * == The id is scoped to the repository
 *
 * `repository.api_keys.find(params[:id])` — a key id belonging to a DIFFERENT
 * repository is a 404, not a cross-repository delete. The bridge relies on that
 * scoping entirely and adds no client-side check of its own, for the reason
 * every tool here states: the server is the gate.
 *
 * == 204 with no body
 *
 * The same empty-body success `remove_repository` serves; the same reason
 * `deleteJson` exists rather than routing a 204 through `requestJson`.
 */
const revokeRepositoryApiKey: ToolDefinition = {
  name: "revoke_repository_api_key",
  title: "Revoke repository API key",
  description:
    "Revokes one CI API key on a SpecGuard repository. The key stops authenticating " +
    "immediately; every OTHER key on the repository keeps working, so CI keeps " +
    "ingesting if it holds a surviving key. " +
    "The `key_id` is scoped to `repository_id`: a key id belonging to a different " +
    "repository is refused 404, never a cross-repository delete. " +
    "Key rotation is mint-then-revoke, in that order: the platform has no regenerate, " +
    "so mint a replacement with `create_repository_api_key` and deploy it BEFORE " +
    "revoking the old one — revoke first and the repository's CI is locked out until " +
    "a human mints a new key in a browser. " +
    "Authorization is the `keys_manage` capability — a member without it is refused " +
    "403 in SpecGuard's own words. A 204 means the key is revoked. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports) and `key_id` " +
    "(the id from `add_repository`'s or `create_repository_api_key`'s response). " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential " +
    "`add_repository` writes with and a DIFFERENT one from the sgk_… repository key " +
    "`get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository the key belongs to — its numeric id, as `add_repository` " +
          "returns and `list_repositories` reports, not the `org/repo` handle.",
      },
      key_id: {
        type: "string",
        description:
          "The id of the key to revoke, as served in the `api_key` block of " +
          "`add_repository` or `create_repository_api_key` (or the repository's " +
          "API-keys page). Scoped to `repository_id`: a foreign key id is refused 404.",
      },
    },
    required: ["repository_id", "key_id"],
    // Closed for the reason every tool here states — and on a DESTRUCTIVE path,
    // a silently dropped misspelled argument must not be able to leave the
    // agent believing it revoked a key the call never named.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const keyId = requireString(args["key_id"], "key_id");

    const api = requireUserApiConfig(context.config);

    const body = await deleteJson(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/api_keys/${encodeURIComponent(keyId)}`,
      context.fetch,
    );

    // 204 with no body — the tool's own words, because the deployment's whole
    // answer was "no content".
    return {
      text:
        body === ""
          ? `Key ${keyId} revoked (204). Other keys on the repository keep authenticating.`
          : body,
      structured: { repository_id: repositoryId, key_id: keyId, revoked: true },
    };
  },
};

export default revokeRepositoryApiKey;
