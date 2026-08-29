import { deleteJson, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `DELETE /api/v1/repositories/:repository_id/members/:id` as a tool — shipped
 * in the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryMembersController#destroy`, SPGD-875).
 *
 * == The two documented asymmetries, stated BEFORE the call
 *
 * Revoking a membership deliberately LEAVES that member's minted CI keys
 * authenticating (`User has_many :created_api_keys, dependent: :nullify`) —
 * the lever for those is the API-keys surface, not this one. And
 * self-revocation is permitted: it is the caller's own access to give up, and
 * after it the next request to these routes answers 404, not 403 (a former
 * member is a non-member). Both belong in the description because they are
 * the facts an agent must know before it commits to the call.
 *
 * == The owner row cannot arrive
 *
 * An owner membership is structurally impossible
 * (`RepositoryMembership#user_is_not_the_owner`), so "cannot remove the owner"
 * is a model invariant, not a guard this bridge re-checks.
 *
 * == 204 with no body
 *
 * The same empty-body success `remove_repository` and
 * `revoke_repository_api_key` serve; the same reason `deleteJson` exists
 * rather than routing a 204 through `requestJson`'s JSON parse.
 */
const removeRepositoryMember: ToolDefinition = {
  name: "remove_repository_member",
  title: "Remove repository member",
  description:
    "Revokes one person's access to a SpecGuard repository by removing their membership. " +
    "The member is named by `member_id` — a MEMBERSHIP id, not a user id — scoped to " +
    "`repository_id`: a membership id belonging to a different repository is refused 404, " +
    "never a cross-repository revoke. " +
    "⚠️ Revoking does NOT revoke that member's minted CI keys — any sgk_… keys they created " +
    "on the repository keep authenticating by design; the lever for those is the API-keys " +
    "surface (`revoke_repository_api_key`), not this one. " +
    "Self-revocation is permitted: a caller may remove their own membership, and their next " +
    "request to the member routes answers 404 — a former member is a non-member, so this tool " +
    "cannot read the repository's members afterwards. The repository owner's membership cannot " +
    "be removed at all (an owner holds everything by construction). " +
    "KNOWN LIMITATION: no API endpoint serves the membership id — the member list and the " +
    "add-member response both omit it by design — so the id must be obtained from the " +
    "platform (today via the repository's web members page); there is no name-based lookup. " +
    "Authorization is the `members.manage` capability — a member without it is refused 403 in " +
    "SpecGuard's own words. A 204 means the membership is revoked. " +
    "Takes `repository_id` — the numeric id `list_repositories` reports, not the `org/repo` " +
    "handle. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential `add_repository` " +
    "writes with and a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository the membership belongs to — its numeric id, as `add_repository` " +
          "returns and `list_repositories` reports, not the `org/repo` handle.",
      },
      member_id: {
        type: "string",
        description:
          "The id of the MEMBERSHIP row to revoke — not a user id, and not the handle. " +
          "Scoped to `repository_id`: a foreign membership id is refused 404. No API endpoint " +
          "serves this id today; obtain it from the platform's web members page.",
      },
    },
    required: ["repository_id", "member_id"],
    // Closed for the reason every tool here states — and on a DESTRUCTIVE path,
    // a silently dropped misspelled argument must not be able to leave the
    // agent believing it revoked a membership the call never named.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const memberId = requireString(args["member_id"], "member_id");

    const api = requireUserApiConfig(context.config);

    const body = await deleteJson(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/members/${encodeURIComponent(memberId)}`,
      context.fetch,
    );

    // 204 with no body — the tool's own words, because the deployment's whole
    // answer was "no content". The keys asymmetry is restated here because the
    // moment of success is the last moment the fact still matters.
    return {
      text:
        body === ""
          ? `Membership ${memberId} revoked (204). That person's minted CI keys on this ` +
            "repository keep authenticating — revoke those separately with " +
            "revoke_repository_api_key if that is the intent."
          : body,
      structured: { repository_id: repositoryId, member_id: memberId, revoked: true },
    };
  },
};

export default removeRepositoryMember;
