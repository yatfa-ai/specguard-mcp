import { deleteJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `DELETE /api/v1/repositories/:repository_id/agent_keys/:id` as a tool —
 * shipped in the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryAgentKeysController#destroy`, SPGD-1004, `dfb9892`).
 *
 * == The blast radius is the whole stored set
 *
 * An agent key's grant — a repository set and a permission set — is chosen
 * once at mint time and stored ONCE, so revocation cuts the token on EVERY
 * repository in the set, not only the one this call names. On the web a
 * confirm dialog names that set BEFORE the cut; over the API there is no
 * dialog, so the disclosure travels in the response that performs it: count
 * first, then the still-existing names, with `deleted_repository_count`
 * present only when repositories have been deleted since mint and dropped out
 * of the names. The tool passes the body through rather than answering with a
 * summary of its own — the deployment already wrote the confirmation, and a
 * second wording of it is a second fact free to drift from the first.
 *
 * == 200 WITH a body, not the sibling's 204
 *
 * `revoke_repository_api_key` says "a 204 means revoked" because every
 * endpoint this bridge's DELETEs served until now answered empty. This one
 * deliberately does not: the disclosure body IS the confirmation, so the call
 * routes through `deleteJsonObject` — `requestJson`'s parse — rather than
 * `deleteJson`'s raw-text handling. The difference is carried in the
 * description because a caller pattern-matching on the sibling's contract
 * would otherwise misread the shape of success here.
 *
 * == The id is scoped, and both forks are 404
 *
 * `AgentApiKey.live.find` + `covers?` — a key id that is revoked already (a
 * retained revoked row is not a credential) or whose stored set does not cover
 * THIS repository is a 404, never a cross-repository cut. The bridge relies on
 * that server scoping entirely and adds no client-side check of its own, for
 * the reason every tool here states: the server is the gate.
 *
 * == The id source
 *
 * No mint tool exists (deliberately web-only), so the id comes from
 * `list_repository_agent_keys` alone — stated in the description rather than
 * left implicit.
 */
const revokeRepositoryAgentKey: ToolDefinition = {
  name: "revoke_repository_agent_key",
  title: "Revoke repository agent key",
  description:
    "Revokes one agent key (`sga_…` key) on a SpecGuard repository. IRREVERSIBLE, and the blast " +
    "radius is the key's WHOLE stored set: the grant (repository set + permission set) is stored " +
    "once at mint time, so this one call cuts the token on EVERY repository the key covers, not " +
    "just `repository_id` — check `repository_count` on `list_repository_agent_keys` BEFORE " +
    "cutting a multi-repository key. " +
    "Answers `200` WITH the disclosure body — an `agent_key` block carrying `revoked_at`, " +
    "`repository_count` and the still-existing `repositories` names, plus " +
    "`deleted_repository_count` when some have been deleted since mint — NOT the empty 204 the " +
    "sgk_ sibling `revoke_repository_api_key` serves; the body itself is the confirmation. " +
    "The `key_id` is scoped to `repository_id`: a key whose stored set does not cover this " +
    "repository, or one already revoked, is refused 404, never a cross-repository cut. " +
    "Agent keys have NO mint tool on this bridge (minting is deliberately web-only), so take " +
    "`key_id` from `list_repository_agent_keys` — list first, then revoke. " +
    "Authorization is the `keys_manage` capability — a caller without it is refused 403 in " +
    "SpecGuard's own words. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports) and `key_id`. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential the other key-administration " +
    "tools read and a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository whose key-administration scope the call is made under — its numeric " +
          "id, as `add_repository` returns and `list_repositories` reports, not the `org/repo` " +
          "handle. The CUT, however, lands on every repository in the key's stored set.",
      },
      key_id: {
        type: "string",
        description:
          "The id of the agent key to revoke, as served by `list_repository_agent_keys` — " +
          "the only id source, because agent keys have no mint tool on this bridge. Scoped to " +
          "`repository_id`: a key whose stored set excludes this repository, or one already " +
          "revoked, is refused 404.",
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

    // The 200 disclosure body, passed through unreshaped in both halves — the
    // deployment already wrote the confirmation (the stored set, count first),
    // and this is the API's substitute for the web confirm dialog.
    const disclosure = await deleteJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/agent_keys/${encodeURIComponent(keyId)}`,
      context.fetch,
    );

    return {
      text: JSON.stringify(disclosure, null, 2),
      structured: disclosure,
    };
  },
};

export default revokeRepositoryAgentKey;
