import { deleteJson, requireUserOrAgentApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `DELETE /api/v1/repositories/:repository_id/runs/:id` as a tool — shipped
 * in the platform (`specguard/config/routes.rb`,
 * `Api::V1::UserRepositoryRunsController#destroy`, SPGD-2014).
 *
 * == Deleting one junk run, not the repository
 *
 * The overview body tells an agent when one run is junk — a cancelled job's
 * half-sized shard row that became the headline `latest_run`, or a run whose
 * `suite_size_measured` is false — but until this endpoint shipped the only
 * destructive verb was `remove_repository`, which deletes EVERY run, key and
 * intent to remove one. This is the surgical lever: one run and its per-run
 * children go, the repository and everything else on it stay.
 *
 * == The id is the overview's `latest_run.id` / `history[].id`
 *
 * A commit_sha deliberately is not the handle: one sha can name several runs
 * of one repository (re-runs, sharded slices), which is exactly why the
 * console anchored pages on `?run=<id>` and why the delete route takes the id.
 * Since SPGD-2014 the overview body serves that id on `latest_run` and on
 * every `history[]` row, so the read that identifies the junk run and the
 * write that removes it are one round trip over tools this server already
 * offers.
 *
 * == The id is scoped to the repository
 *
 * `repository.test_runs.find_by(id: params[:id])` + an explicit raise — a run
 * id belonging to a DIFFERENT repository is a 404 with the same crafted
 * sentence an unknown id answers, never a cross-repository delete and never a
 * disclosure that a foreign id exists. The bridge adds no client-side check
 * of its own, for the reason every tool here states: the server is the gate.
 *
 * == Authorization is `repo.delete`, the same gate `remove_repository` uses
 *
 * A run is not a separately-shareable object — it is repository history, and
 * the price of removing one is bounded above by the price of removing the
 * repository. The tool does not probe for the capability client-side.
 *
 * == 204 with no body
 *
 * The same empty-body success `remove_repository` and
 * `revoke_repository_api_key` serve — the reason `deleteJson` exists rather
 * than routing a 204 through `requestJson`'s JSON parse.
 */
const removeRepositoryRun: ToolDefinition = {
  name: "remove_repository_run",
  title: "Remove repository run",
  description:
    "Deletes ONE test run from a SpecGuard repository — the junk-run lever beside " +
    "`remove_repository`, which deletes every run, key and intent at once. IRREVERSIBLE: " +
    "the run, its per-shard rows and its per-example observations are gone, with no undo " +
    "and no bulk or by-branch delete anywhere on the surface. " +
    "Read the id off the overview first: `latest_run.id` and every `history[]` row's `id` " +
    "(SPGD-2014) are the only handle this route accepts — a commit_sha deliberately is " +
    "not one, because one sha can name several runs of one repository. " +
    "The `run_id` is scoped to `repository_id`: a run id belonging to a different " +
    "repository answers the same 404 an unknown id answers, never a cross-repository " +
    "delete. " +
    "After a delete the overview's `latest_run` and the growth blocks may anchor on an " +
    "OLDER run — deleting the newest run moves `latest_test_run` to the next-newest row, " +
    "so re-read `get_repository_overview` before trusting any figure that was anchored on " +
    "the run you just removed; SpecGuard also enqueues a near-duplicates census refresh " +
    "for exactly that reason. " +
    "Authorization is the `repo.delete` capability — the same gate `remove_repository` " +
    "answers, because a run is repository history and removing one is bounded above by " +
    "removing the repository; a member without it is refused 403 in SpecGuard's own " +
    "words. A 204 means the run is deleted. " +
    "Takes `repository_id` (the numeric id `list_repositories` reports) and `run_id` — " +
    "the numeric id served on `latest_run.id` and on every `history[]` row of " +
    "`get_repository_overview`. " +
    "It authenticates with EITHER of this server's two repository-administration credentials, " +
    "whichever is set: SPECGUARD_AGENT_API_KEY (an sga_… key — the call then reaches only the " +
    "repositories granted onto that key at mint time, and only where the grant carries " +
    "`repo.delete`; a repository outside that set answers 404 in SpecGuard's own words, never " +
    "a probe here) and, when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key, the same " +
    "credential `add_repository` writes with). With both set the agent key wins, so the " +
    "deletion answers inside the same set `list_repositories` reports. " +
    "Either way it is a DIFFERENT credential from the sgk_… repository key " +
    "`get_repository_overview` uses; SpecGuard refuses each in the other's place.",
  inputSchema: {
    type: "object",
    properties: {
      repository_id: {
        type: "string",
        description:
          "The repository the run belongs to — its numeric id, as `add_repository` " +
          "returns and `list_repositories` reports, not the `org/repo` handle.",
      },
      run_id: {
        type: "string",
        description:
          "The id of the run to delete — the numeric id served on `latest_run.id` and " +
          "on every `history[]` row of `get_repository_overview` (SPGD-2014), the same " +
          "number `POST /ingest` answers as `test_run_id`. A commit_sha deliberately is " +
          "not this handle: one sha can name several runs of one repository. Scoped to " +
          "`repository_id`: a foreign run id answers the same 404 an unknown id answers.",
      },
    },
    required: ["repository_id", "run_id"],
    // Closed for the reason every tool here states — and on a DESTRUCTIVE path,
    // a silently dropped misspelled argument must not be able to leave the
    // agent believing it deleted a run the call never named.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const repositoryId = requireString(args["repository_id"], "repository_id");
    const runId = requireString(args["run_id"], "run_id");

    const api = requireUserOrAgentApiConfig(context.config);

    const body = await deleteJson(
      api,
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/runs/${encodeURIComponent(runId)}`,
      context.fetch,
    );

    // 204 with no body — the tool's own words, because the deployment's whole
    // answer was "no content". The anchor warning is the part of the verb's
    // consequence an agent cannot see from a bare 204: the run it removed may
    // have been the one every anchored block named.
    return {
      text:
        body === ""
          ? `Run ${runId} deleted (204). It is gone from the repository's history; if it was ` +
            `the newest run, the overview's latest_run and the growth blocks now anchor on ` +
            `an older run — re-read get_repository_overview before trusting figures that ` +
            `were anchored on it.`
          : body,
      structured: { repository_id: repositoryId, run_id: runId, deleted: true },
    };
  },
};

export default removeRepositoryRun;
