import { requireApiConfig } from "../config.js";
import { ApiError, ArgumentError } from "../errors.js";
import { getJson } from "../support/specguard-api.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repository` as a tool — shipped today in the platform
 * (`specguard/config/routes.rb`, `Api::V1::RepositoriesController`).
 *
 * == Why this endpoint is the right second tool
 *
 * It is the agent-readable half of the repository dashboard, and its controller
 * says why it exists in the first line of its own comment: *without* it "an
 * agent can learn the suite's size only by running the suite and POSTing it — it
 * cannot ask". That is the cold-start requirement in Project Goals (SPGD-1) and
 * it is already met server-side; what was missing is a way for an agent to reach
 * it without writing HTTP and Bearer plumbing into its prompt. This tool is
 * exactly that gap and nothing more.
 *
 * One request answers what the suite is, what the last CI run cost, where the
 * time went (by file, by directory, by individual example), and how the suite
 * has grown — so the tool is described in those terms rather than as "get
 * repository", which is not a question anybody asks.
 *
 * == The response is passed through, not re-modelled
 *
 * Every figure in that body is annotated in the controller with the reason for
 * its exact shape, and several of those reasons are about honesty rather than
 * convenience: `null` where a value was not measured (never a zero that would
 * read as a measurement), counts served beside the figures they are the
 * denominator of, `tie_break_served: false` admitting the array's order is not
 * reproducible from the fields served. Any reshaping here — flattening,
 * defaulting a null to 0, re-sorting a list — would discard the distinction the
 * controller spent that care preserving. So the body goes back as it arrived.
 *
 * == `branch` narrows the history, and only the history
 *
 * That asymmetry is a documented property of the endpoint rather than a
 * surprise, and it is stated in the schema because an agent that has not read
 * the controller would otherwise read `latest_run` as belonging to the branch it
 * asked for.
 *
 * == `spec_directory` opens an area the ranking only names
 *
 * `latest_run.spec_directories` ranks the heaviest directories and is served
 * unconditionally, so an agent can already see WHERE the time went — but the
 * ranking is at the area grain and cannot say which files inside the area spent
 * it. `?spec_directory=` is the endpoint's answer to that, and the server has
 * served it since the controller took `RequestedSpecDirectoryParam`: the key
 * `latest_run.spec_directory_files` opens from `null` to a populated object the
 * moment the parameter is sent. This bridge withheld it by not offering the
 * parameter, which made the ranking a dead end for every agent that reached it
 * through MCP.
 *
 * The parameter is forwarded and nothing about it is interpreted here. The
 * server owns the whole meaning of the answer — `null` for "you did not ask",
 * `rows: []` for "asked, matched nothing" (a renamed or deleted directory is an
 * ordinary way to arrive, not an error), and a non-String shape read as no ask
 * at all. A blank one sends no parameter, exactly as `branch` does and for the
 * same reason: `getJson` omits an `undefined` value, so `optionalString` is the
 * whole of the blank-handling in both cases.
 *
 * == `spec_file` and `repeated_description` are the same argument, twice more
 *
 * The endpoint serves a FOUR-rung drill-down ladder and this bridge forwarded
 * two of them. The sentence above — "this bridge withheld it by not offering
 * the parameter, which made the ranking a dead end for every agent that reached
 * it through MCP" — was true verbatim of two further rungs, and the block was
 * doubled: `additionalProperties: false` REJECTED the argument before the call,
 * and `run()` would have dropped it anyway. Both rankings are served
 * unconditionally to every caller, so the agent was shown the door and denied
 * the handle:
 *
 *   `latest_run.spec_files`            → `spec_file_examples`            (`spec_file`)
 *   `latest_run.repeated_descriptions` → `repeated_description_examples` (`repeated_description`)
 *
 * Both follow `spec_directory` exactly — one schema property, one
 * `optionalString` call, one query key — because the pass-through above means
 * the drilled keys populate the moment the parameter is forwarded, with no
 * serializer or rendering work anywhere on this side.
 *
 * The fourth rung is worth naming separately: `repeated_description_examples`
 * is reachable from NO other key. `slowest_examples` is the run-wide top ten
 * and a group's members are usually absent from it entirely, and walking
 * `spec_file_examples` over each path in the group's `files_seen` is N
 * unrelated lists each cut at 50 BY DURATION, with no guarantee any of the
 * group's members survive the cut in any of them. Withholding this one
 * parameter withheld the capability, not merely a shortcut to it.
 */
const getRepositoryOverview: ToolDefinition = {
  name: "get_repository_overview",

  title: "Get SpecGuard repository overview",

  description:
    "Ask SpecGuard what a repository's test suite looks like, WITHOUT running it. Returns the " +
    "repository the configured API key resolves to, its latest CI run (total and annotated spec " +
    "counts, annotated ratio, wall-clock and per-shard cost), where that run spent its time " +
    "(heaviest spec files, heaviest directories, slowest individual examples with file and line), " +
    "which descriptions are repeated across the suite (the overcoverage ranking: one description " +
    "carried by many examples, and which files it is spread over), " +
    "the recent run history for growth over time, and the branches that have runs. " +
    "Three of those rankings open: pass `spec_directory` to see the spec files inside one of the " +
    "heaviest directories, `spec_file` to see the individual examples inside one of the heaviest " +
    "files, or `repeated_description` to see the examples that all share one repeated description. " +
    "Use it to orient in an unfamiliar suite, to find what is slow before optimising, to find " +
    "duplicated coverage before refactoring, or to see annotation coverage. " +
    "Needs SPECGUARD_ENDPOINT and SPECGUARD_API_KEY. " +
    "Figures are null where CI did not report them — a null is 'not measured', never zero.",

  inputSchema: {
    type: "object",
    properties: {
      branch: {
        type: "string",
        description:
          "Narrow the run history to one branch, giving a real growth series instead of the " +
          "default all-branches window (whose consecutive rows are routinely different branches " +
          "and must not be differenced). Narrows `history` ONLY: `latest_run` always names the " +
          "repository's newest run, which on a busy repo may be on another branch. Use a name " +
          "from `branches`; an unknown one returns an empty history rather than an error.",
      },
      spec_directory: {
        type: "string",
        description:
          "Open ONE area of the `latest_run.spec_directories` ranking, which says where the time " +
          "went by directory but not which files inside it spent it. Use a path exactly as served " +
          "in `latest_run.spec_directories.rows[].path`. Asking populates " +
          "`latest_run.spec_directory_files` — the spec files in that one directory with their " +
          "`total_seconds`/`recorded_count`/`timed_count`, plus the AREA's own `file_count`, " +
          "`recorded_count`, `timed_count` and the `limit` the row list was cut at (the totals " +
          "describe the whole area, not the returned page, so do not re-derive them from `rows`). " +
          "Omit it and the key is `null`, meaning you did not ask — an area the run recorded " +
          "nothing for is `rows: []` instead, not an error.",
      },
      spec_file: {
        type: "string",
        description:
          "Open ONE file of the `latest_run.spec_files` ranking, which says which files cost the " +
          "most but not which examples inside them spent it. Use a path exactly as served in " +
          "`latest_run.spec_files.rows[].path`. Asking populates " +
          "`latest_run.spec_file_examples` — up to 50 of that file's individual examples cut by " +
          "DURATION, each with `name`, `file_path`, `line_number`, `spec_file_path`, " +
          "`duration_seconds` and `outcome`, plus the FILE's own `recorded_count` and " +
          "`timed_count` and the `limit` the row list was cut at (the totals describe the whole " +
          "file, not the returned page, so do not re-derive them from `rows`). " +
          "Omit it and the key is `null`, meaning you did not ask — a file that matched nothing " +
          "is `rows: []` instead, not an error: a renamed or deleted spec file and a stale " +
          "bookmark are ordinary ways to arrive.",
      },
      repeated_description: {
        type: "string",
        description:
          "Open ONE group of the `latest_run.repeated_descriptions` ranking — the overcoverage " +
          "ranking, which names descriptions carried by many examples but not WHICH examples say " +
          "the same thing. Use a description exactly as served in " +
          "`latest_run.repeated_descriptions.rows[].name`. Asking populates " +
          "`latest_run.repeated_description_examples` — up to 25 of that group's members, each " +
          "with `name`, `file_path`, `line_number`, `spec_file_path`, `duration_seconds` and " +
          "`outcome`, plus the GROUP's own `recorded_count` and `timed_count` and the `limit` " +
          "the row list was cut at (the totals describe the whole group, not the returned page, " +
          "so do not re-derive them from `rows`). This is the ONLY way to reach a group's " +
          "members: `slowest_examples` is the run-wide top ten and rarely contains them, and " +
          "`spec_file` over each path in `files_seen` cuts each file by duration with no " +
          "guarantee the group's members survive. " +
          "Omit it and the key is `null`, meaning you did not ask — a description that matched " +
          "nothing is `rows: []` instead, not an error: a test renamed since and an edited " +
          "description are ordinary ways to arrive.",
      },
    },
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const branch = optionalString(args["branch"], "branch");
    const specDirectory = optionalString(args["spec_directory"], "spec_directory");
    const specFile = optionalString(args["spec_file"], "spec_file");
    const repeatedDescription = optionalString(
      args["repeated_description"],
      "repeated_description",
    );
    const api = requireApiConfig(context.config);

    const body = await getJson(
      api,
      "/api/v1/repository",
      {
        branch,
        spec_directory: specDirectory,
        spec_file: specFile,
        repeated_description: repeatedDescription,
      },
      context.fetch,
    );

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiError("SpecGuard returned a JSON value that was not an object.");
    }

    const overview = body as Record<string, unknown>;

    return {
      text: renderText(overview),
      structured: overview,
    };
  },
};

export default getRepositoryOverview;

/**
 * The text rendering is the SAME object serialised — deliberately not a prose
 * summary of it.
 *
 * A summary would have to choose which of the response's figures to keep, and
 * every one of them is there because the controller argued it was not derivable
 * from the others. Worse, wording them would re-introduce exactly what that
 * endpoint refuses to serve: it emits structured counts rather than the
 * dashboard's English captions, on the grounds that a machine-readable client
 * cannot act on a sentence. Turning them back into sentences here would undo
 * that on the last hop.
 */
function renderText(overview: Record<string, unknown>): string {
  return JSON.stringify(overview, null, 2);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ArgumentError(`\`${field}\` must be a string.`);
  return value.trim() === "" ? undefined : value.trim();
}
