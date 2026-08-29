import { postJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { optionalStringArray, requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `POST /api/v1/repositories/:repository_id/members` as a tool — shipped in the
 * platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryMembersController#create`, SPGD-875).
 *
 * == The handle is the LOGIN itself
 *
 * `User.resolve_by_handle` refuses a profile URL and a display name with its
 * own sentence ("Send the login itself — octocat, not a profile URL or a
 * display name"), and each non-`:found` resolution — never-signed-in,
 * archived, ambiguous, malformed — arrives as a distinguishable 400 sentence
 * through the landed `refusalMessage` branch. This bridge does not re-derive
 * that vocabulary: a client-side copy is a rule with no owner, free to drift
 * from the one that actually decides.
 *
 * == The grantor is always the authenticated principal
 *
 * `granted_by_user` is stamped server-side from the `sgu_` credential and is
 * deliberately absent from the permitted params. The tool therefore takes no
 * grantor argument, and no caller can name one.
 *
 * == The 201 body omits the membership id, by server design
 *
 * `#serialize` serves `handle`, `permissions`, `granted_by`, `created_at` —
 * and no id, because ids are not portable between repositories and serving
 * one invites treating it as portable. See
 * `update_repository_member_permissions` for where the id comes from today.
 */
const addRepositoryMember: ToolDefinition = {
  name: "add_repository_member",
  title: "Add repository member",
  description:
    "Grants a person access to a SpecGuard repository by their GitHub handle, with an optional " +
    "list of permissions. " +
    "The `handle` is the LOGIN itself — `octocat`, not a profile URL and not a display name: " +
    "SpecGuard refuses each of those with its own sentence, and every other resolution failure " +
    "(nobody has signed in as that handle yet, the account is archived, the handle is ambiguous) " +
    "arrives as a distinguishable 400 message naming the exact next move. " +
    "The grantor recorded on the membership is always the person behind this server's user API " +
    "key — the server stamps it, and no argument can name a different one. " +
    "On success (201) the response carries a `member` block (`handle`, `permissions`, " +
    "`granted_by`, `created_at`). It carries NO membership id, by design: ids are not portable " +
    "between repositories, and editing or revoking a membership names a membership id obtained " +
    "from the platform (today only via the web members page) — see the edit/revoke tools. " +
    "Permissions are strings from SpecGuard's own set (`view`, `keys.manage`, `members.manage`, " +
    "`repo.delete`); an unknown value is refused in SpecGuard's own words, and omitting the " +
    "list grants access with no additional permissions. The repository owner cannot be added " +
    "(they hold everything by construction). " +
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
          "The repository to grant access to — its numeric id, as `add_repository` " +
          "returns and `list_repositories` reports, not the `org/repo` handle.",
      },
      handle: {
        type: "string",
        description:
          "The GitHub login of the person to add, e.g. `octocat` — not a profile URL and not a " +
          "display name; SpecGuard refuses both with its own sentence. The person must have " +
          "signed in to SpecGuard at least once.",
      },
      permissions: {
        type: "array",
        items: { type: "string" },
        description:
          "An optional list of permission strings from SpecGuard's own set (`view`, " +
          "`keys.manage`, `members.manage`, `repo.delete`). Omit it to grant access with no " +
          "additional permissions. SpecGuard validates the values and refuses an unknown one " +
          "in its own words.",
      },
    },
    required: ["repository_id", "handle"],
    // Closed for the reason every tool here states — and on a WRITE, a silently
    // dropped misspelled argument still grants something, just not what the
    // agent believed it was asking for.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const handle = requireString(args["handle"], "handle");
    const permissions = optionalStringArray(args["permissions"], "permissions");

    const api = requireUserApiConfig(context.config);

    // Top-level `{handle, permissions}` — the shape the controller permits,
    // matching `add_repository`'s stated rule: this is JSON an agent writes,
    // not a Rails form. `permissions` omitted when absent so the server's own
    // default applies; passed through as an ARRAY when present (the column is
    // `text[]`, and a scalar on the wire is silently dropped server-side).
    const created = await postJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/members`,
      permissions === undefined ? { handle } : { handle, permissions },
      context.fetch,
    );

    // Unreshaped, the standing rule — and the 201 body is the only answer this
    // verb gives; nothing here exists to re-fetch elsewhere.
    return {
      text: JSON.stringify(created, null, 2),
      structured: created,
    };
  },
};

export default addRepositoryMember;
