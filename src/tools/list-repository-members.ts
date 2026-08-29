import { getJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repositories/:repository_id/members` as a tool — shipped in the
 * platform (`specguard/config/routes.rb`, `Api::V1::UserRepositoryMembersController#index`,
 * SPGD-875).
 *
 * == Memberships only, never `keys_minted`
 *
 * The endpoint answers the same rows the web members page renders — `handle`,
 * `permissions`, `granted_by`, `created_at`, ordered by handle — and
 * deliberately NOTHING else. `keys_minted` is a `keys.manage` disclosure that
 * page gates separately; this read answers memberships to a `members.manage`
 * holder and no more. A tool that promised counts here would be promising
 * something the endpoint refuses to say.
 *
 * == No membership id, by design
 *
 * The body carries no membership id: ids are not portable between
 * repositories, and serving one would invite treating it as portable. PATCH
 * and DELETE still name rows by that id — see
 * `update_repository_member_permissions` and `remove_repository_member` for
 * where the id comes from today.
 *
 * == No client-side capability probing
 *
 * The server gates at `current_repository(:members_manage)`: a non-member gets
 * 404 (the repository's existence stays hidden), a member without the
 * capability gets 403 with SpecGuard's own sentence. This tool predicts
 * neither; it reports what came back.
 */
const listRepositoryMembers: ToolDefinition = {
  name: "list_repository_members",
  title: "List repository members",
  description:
    "Lists who has access to a SpecGuard repository: one row per member with their `handle`, " +
    "`permissions`, `granted_by` (who last set them) and `created_at`, ordered by handle. " +
    "The list answers MEMBERSHIPS only and never reports how many CI keys a member has minted " +
    "(`keys_minted`) — that is a separate `keys.manage` disclosure this endpoint deliberately " +
    "withholds, and the API-keys tools are the surface for it. " +
    "Authorization is the `members.manage` capability: a caller who is not a member of the " +
    "repository is refused 404 (the repository's existence stays hidden), and a member without " +
    "`members.manage` is refused 403 in SpecGuard's own words. " +
    "Takes `repository_id` — the numeric id `list_repositories` reports, not the `org/repo` " +
    "handle. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential `list_repositories` " +
    "reads and a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository whose members to list — its numeric id, as `add_repository` " +
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

    const members = await getJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/members`,
      {},
      context.fetch,
    );

    // Passed through unreshaped, the standing rule (`types.ts`: "A thin client
    // that reshapes its upstream is not thin") — the endpoint serves the same
    // four fields the web members page renders, under the same names.
    return {
      text: JSON.stringify(members, null, 2),
      structured: members,
    };
  },
};

export default listRepositoryMembers;
