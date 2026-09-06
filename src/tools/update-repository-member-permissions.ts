import { patchJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString, requireStringArray } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `PATCH /api/v1/repositories/:repository_id/members/:id` as a tool — shipped
 * in the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryMembersController#update`, SPGD-875).
 *
 * == The body is `{permissions: []}` and nothing else
 *
 * The controller permits exactly that one key, and the ARRAY form because the
 * column is `text[]`: a scalar permit silently drops the array server-side.
 * This tool therefore REQUIRES a string array — a scalar or nested value is
 * refused client-side as a shape error before anything is sent.
 *
 * == The id is a MEMBERSHIP id, scoped to the repository
 *
 * `find_membership!` looks the row up THROUGH the repository, so a membership
 * id belonging to a different repository is a 404, never a cross-repository
 * write. The bridge adds no client-side check of that scoping: the server is
 * the gate.
 *
 * == Where the id comes from
 *
 * `#serialize` serves the membership id on every member response — the list
 * (`list_repository_members`), the 201 body (`add_repository_member`) and
 * this tool's own 200 body — so an agent that listed or added a member
 * already holds the id this call names. There is no name-based lookup: the
 * id comes off those responses, and lookup is scoped through the repository
 * (a foreign id is refused 404).
 */
const updateRepositoryMemberPermissions: ToolDefinition = {
  name: "update_repository_member_permissions",
  title: "Update repository member permissions",
  description:
    "Replaces one member's permission set on a SpecGuard repository. The member is named by " +
    "`member_id` — a MEMBERSHIP id, not a user id — and the id is SCOPED to `repository_id`: " +
    "a membership id belonging to a different repository is refused 404, never a " +
    "cross-repository write. " +
    "⚠️ `permissions` REPLACES the whole set — it is not merged with what the member holds " +
    "today, so name every permission the member should end with. Values are strings from " +
    "SpecGuard's own set (`view`, `keys.manage`, `members.manage`, `repo.delete`); an unknown " +
    "value is refused in SpecGuard's own words. " +
    "The membership id comes straight off the API: every member response carries it as `id` — " +
    "the rows `list_repository_members` serves, the `add_repository_member` 201 body, and this " +
    "tool's own response — so a member you listed or added has already handed you the id. " +
    "Authorization is the `members.manage` capability — a member without it is refused 403 in " +
    "SpecGuard's own words. " +
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
          "The id of the MEMBERSHIP row to edit — not a user id, and not the handle. Scoped " +
          "to `repository_id`: a foreign membership id is refused 404. Take it from the `id` " +
          "field of a member row served by `list_repository_members`, `add_repository_member` " +
          "or this tool's own response.",
      },
      permissions: {
        type: "array",
        items: { type: "string" },
        description:
          "The member's COMPLETE new permission set, replacing what they hold today — e.g. " +
          "[\"view\", \"keys.manage\"]. Not merged. An empty array removes every additional " +
          "permission while keeping the membership.",
      },
    },
    required: ["repository_id", "member_id", "permissions"],
    // Closed for the reason every tool here states — and on a WRITE that
    // REPLACES a permission set, a silently dropped misspelled argument must
    // not be able to leave the agent believing it granted a permission the
    // call never carried.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const memberId = requireString(args["member_id"], "member_id");
    // REQUIRED, and required as an ARRAY: the server column is `text[]` and a
    // scalar on the wire is silently dropped server-side, so the shape error is
    // caught here — before a write — rather than persisted as a member holding
    // nothing.
    const permissions = requireStringArray(args["permissions"], "permissions");

    const api = requireUserApiConfig(context.config);

    const updated = await patchJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/members/${encodeURIComponent(memberId)}`,
      { permissions },
      context.fetch,
    );

    // Unreshaped, the standing rule — the 200 body is this verb's whole answer.
    return {
      text: JSON.stringify(updated, null, 2),
      structured: updated,
    };
  },
};

export default updateRepositoryMemberPermissions;
