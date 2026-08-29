import { patchJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `PATCH /api/v1/repositories/:id` as a tool — shipped in the platform
 * (`specguard/config/routes.rb:186`, `Api::V1::UserRepositoriesController#update`,
 * SPGD-878, PR #266).
 *
 * == Why this tool exists at all
 *
 * Before it, the only way to change a repository's `org/repo` name through the
 * bridge was `remove_repository` plus `add_repository` — which destroys every
 * API key, every run and every intent on the repository, because that is what
 * remove does. The platform's rename endpoint keeps all of it; this tool is
 * the bridge's one-line path to that.
 *
 * == Authorization is OWNER-ONLY — deliberately narrower than delete
 *
 * The controller gates through `current_repository(:owner)`, NOT the
 * `repo.delete` capability fork `remove_repository` authorizes through — so a
 * member granted `repo.delete` may DESTROY the repository but may NOT rename
 * it. The asymmetry is the platform's, and the description carries it rather
 * than papering over it.
 *
 * == The grant precondition
 *
 * The owner check redeems a browser-issued grant that is valid for seven days;
 * a nil or stale one is a 403 whose own sentence names the fix (re-grant via
 * the browser). The bridge surfaces that sentence verbatim and adds no
 * client-side grant handling — the server is the gate.
 *
 * == The body is top-level `{github_full_name}` — NOT nested
 *
 * `update_params` permits `github_full_name` at the TOP level, not under a
 * `repository` key; a nested body is silently empty to the server. And a taken
 * name is a 400 (`render_bad_request`, the `taken` branch), not a 409 — this
 * description says so because it is the one answer an agent is most likely to
 * mispredict.
 *
 * == The 200 body is the list_repositories shape
 *
 * `{repository: serialize(...)}` — the same serializer `list_repositories`
 * serves, so the response needs no reshaping and gets none.
 */
const renameRepository: ToolDefinition = {
  name: "rename_repository",
  title: "Rename repository",
  description:
    "Renames a SpecGuard repository — changes the `org/repo` GitHub full name it is registered " +
    "under — WITHOUT destroying anything. This is the alternative to the remove-and-re-register " +
    "path: that one deletes every API key, run and intent on the repository, while this keeps " +
    "all of them. " +
    "⚠️ Authorization is OWNER-ONLY — deliberately narrower than removal: a member granted " +
    "`repo.delete` may destroy the repository but may NOT rename it. The owner check also " +
    "redeems a browser-issued grant valid for 7 days; a nil or stale one is refused 403 in " +
    "SpecGuard's own words, and that sentence names the fix (re-grant via the browser). " +
    "A name another repository already holds is refused 400 — `taken`, not 409 — with " +
    "SpecGuard's own sentence. The 200 body is `{repository: …}` in the same shape " +
    "`list_repositories` serves. " +
    "Takes `repository_id` — the numeric id `add_repository` returns and `list_repositories` " +
    "reports, not the `org/repo` handle — and `github_full_name`, the new `org/repo` name. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential `add_repository` " +
    "writes with and a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The id of the repository to rename — the numeric id `add_repository` returns and " +
          "`list_repositories` reports, not the `org/repo` handle. SpecGuard scopes the lookup " +
          "to repositories you own and answers 404 otherwise.",
      },
      github_full_name: {
        type: "string",
        description:
          "The repository's new GitHub full name, `org/repo` — sent TOP-LEVEL in the request " +
          "body, not nested under `repository`. A name another repository already holds is " +
          "refused 400 (`taken`).",
      },
    },
    required: ["repository_id", "github_full_name"],
    // Closed for the reason every tool here states: `server.ts` forwards
    // `arguments` unvalidated, and a silently dropped misspelled argument on
    // a WRITE must not be able to leave the agent believing it renamed to a
    // name the call never carried.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const githubFullName = requireString(args["github_full_name"], "github_full_name");

    const api = requireUserApiConfig(context.config);

    const updated = await patchJsonObject(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
      { github_full_name: githubFullName },
      context.fetch,
    );

    // Unreshaped, the standing rule — the 200 body (`{repository: serialize}` ,
    // the `list_repositories` shape) is this verb's whole answer.
    return {
      text: JSON.stringify(updated, null, 2),
      structured: updated,
    };
  },
};

export default renameRepository;
