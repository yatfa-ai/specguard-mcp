import { deleteJson, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `DELETE /api/v1/repositories/:id` as a tool — shipped in the platform
 * (`specguard/config/routes.rb:152`, `Api::V1::UserRepositoriesController#destroy`,
 * SPGD-754).
 *
 * == The destructive gesture in the whole surface
 *
 * Everything else here reads, registers, or mints. This one removes a
 * repository AND every key, run and intent on it (`memberships_helper.rb`:
 * "Delete the repository, and every key, run and intent on it"), and there is no
 * undo. The description therefore carries the hazard BEFORE the call: it is
 * prompt material, read when the agent is deciding whether to act, not a
 * footnote discovered after.
 *
 * == Authorization is `repo.delete` at either surface
 *
 * The controller authorizes through `RepositoryAuthorization`'s `:repo_delete`
 * fork — deliberately NOT `:owner` — so a member granted `repo.delete` may
 * remove the repository from either surface. The tool does not probe for the
 * capability client-side: the server is the gate, and a member without it
 * receives a 403 whose sentence arrives verbatim through the landed
 * `refusalMessage` branch in `describeFailure`.
 *
 * == 204 with no body
 *
 * This is the one response in the `sgu_` surface that is deliberately not a
 * JSON body — which is why `deleteJson` exists: routing an empty-body 204
 * through `requestJson`'s JSON parse would turn a successful delete into
 * "the body was not JSON". Here, no body IS the success.
 */
const removeRepository: ToolDefinition = {
  name: "remove_repository",
  title: "Remove repository",
  description:
    "Removes a repository from SpecGuard, DELETING every key, run and intent on it. " +
    "This is IRREVERSIBLE: the repository's CI keys stop authenticating and its recorded " +
    "runs and intents are gone, with no undo and no way to recover them short of " +
    "re-registering from scratch. A 204 means it is deleted. " +
    "Authorization is the `repo.delete` capability at either surface — an owner, or a " +
    "member granted it, may remove the repository; a member without it is refused 403 in " +
    "SpecGuard's own words. Confirm with the user before calling: this is the destructive " +
    "gesture in this toolset, and once it returns 204 the repository and its history " +
    "cannot be brought back. " +
    "Takes `repository_id` — the numeric id `add_repository` and `list_repositories` " +
    "report, not the `org/repo` handle. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential `add_repository` " +
    "writes with and a DIFFERENT one from the sgk_… repository key " +
    "`get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The id of the repository to remove — the numeric id `add_repository` returns " +
          "and `list_repositories` reports, not the `org/repo` handle. SpecGuard scopes " +
          "the lookup to repositories you may act on and answers 404 otherwise.",
      },
    },
    required: ["repository_id"],
    // Closed for the reason every tool here states: `server.ts` forwards
    // `arguments` unvalidated, and on the DESTRUCTIVE path a silently-dropped
    // argument is the worst case of the write-path argument — the call still
    // deletes something, just not what the agent believed it named.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");

    const api = requireUserApiConfig(context.config);

    const body = await deleteJson(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
      context.fetch,
    );

    // 204 with no body. Nothing upstream to pass through, so the result says
    // what the verb did — in the tool's own words, because the deployment's
    // whole answer was "no content".
    return {
      text: body === "" ? "Repository removed (204). Every key, run and intent on it is deleted." : body,
      structured: { repository_id: repositoryId, deleted: true },
    };
  },
};

export default removeRepository;
