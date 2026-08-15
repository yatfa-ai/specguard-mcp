import { requireApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { getJson } from "../support/specguard-api.js";
import { optionalString } from "./args.js";
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
 * At that point the endpoint served a FOUR-rung drill-down ladder and this
 * bridge forwarded two of them. The sentence above — "this bridge withheld it
 * by not offering the parameter, which made the ranking a dead end for every
 * agent that reached it through MCP" — was true verbatim of two further rungs,
 * and the block was doubled: `additionalProperties: false` REJECTED the
 * argument before the call, and `run()` would have dropped it anyway. Both
 * rankings are served unconditionally to every caller, so the agent was shown
 * the door and denied the handle:
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
 *
 * == `unstable_test` is the fifth rung, and the same argument once more
 *
 *   `unstable_tests.rows` → `unstable_tests.unstable_test_runs` (`unstable_test`)
 *
 * A flakiness row says `run_count: 30`, `failed_run_count: 4`,
 * `outcome_words: ["failed", "passed"]`. Those three figures are IDENTICAL for
 * two windows that call for opposite work: four failures in runs 27–30 is a
 * REGRESSION, and the work is to find the commit between run 26 and run 27;
 * four failures in runs 3, 11, 19 and 26 is genuine FLAKINESS, where there is
 * no culprit commit and the work is quarantine or shared state. The RUN
 * SEQUENCE is the only thing that separates them, and it is derivable from
 * nothing else this bridge returns — `history` has no per-test grain, and both
 * example drill-ins carry `outcome` for the LATEST RUN alone. So this is the
 * fourth rung's argument again: withholding the parameter withheld the
 * capability rather than a shortcut to it, and an agent told to "fix the flaky
 * tests" hunts nondeterminism in tests that fail deterministically.
 *
 * TWO THINGS DIFFER FROM ITS FOUR SIBLINGS, and both are stated in the schema
 * because neither is guessable from the ladder. The answer lands INSIDE the
 * flakiness block — `unstable_tests.unstable_test_runs`, not under
 * `latest_run.*` where the two example drill-ins live — and `branch` is a hard
 * PREREQUISITE rather than a suggestion: `unstable_tests` is served only for a
 * branch-narrowed window, so this parameter sent alone yields no block at all
 * to drill into. Every sibling works on a plain call; this one does not.
 *
 * THE SEQUENCE RUNS NEWEST RUN FIRST, and that is stated in the schema too,
 * because this is the one list on this tool where the direction IS the payload.
 * The window is `Repository#recent_test_runs`, ordered `created_at: :desc`, and
 * `SpecObservation.outcome_sequence_in` PRESERVES that order rather than
 * re-sorting it. Read front-to-back as run 1 → run N, the regression above
 * reads as four failures at the START of the window that have passed since —
 * a fixed flake, the exact inversion of the truth, with no error anywhere to
 * signal it. The consequence worth stating outright: the run a failure STARTED
 * at is the LAST row of the leading failed block, not the first. The 200 cap
 * takes rows off the OLD end for the same reason, so a truncated sequence is
 * still the recent runs.
 *
 * The run a row belongs to is read off its `commit_sha` / `test_run_id` and
 * NEVER off its index. `rows.length` is not the window's `run_count`: a run
 * that recorded nothing under the description contributes no row, and a
 * description carried by two examples in one run contributes two. Same
 * direction as `history` is not same index into it.
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
    "which areas of the suite grew or shrank and which got slower or faster since the previous run " +
    "on the same branch (the per-area comparisons, at BOTH the example-count grain and the " +
    "runtime grain — an area where an existing spec was made slow gains no examples and appears " +
    "only in the runtime one), " +
    "the recent run history for growth over time, and the branches that have runs. " +
    "Pass `branch` for two more: which tests fail intermittently rather than consistently (the " +
    "cross-run flakiness ranking) and how the areas moved across the whole branch window rather " +
    "than between the last two runs. " +
    "Four of those rankings open: pass `spec_directory` to see the spec files inside one of the " +
    "heaviest directories — and, in the same answer, which of those files grew and which got " +
    "slower — `spec_file` to see the individual examples inside one of the heaviest files, " +
    "`repeated_description` to see the examples that all share one repeated description, or " +
    "`unstable_test` (alongside `branch`) to see one flaky test's outcome run by run, which is " +
    "the only way to tell a regression from genuine flakiness. " +
    "Use it to orient in an unfamiliar suite, to find what is slow before optimising, to find " +
    "what got slower or bigger since last time, to find which tests are flaky, to find " +
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
          "from `branches`; an unknown one returns an empty history rather than an error. " +
          "It also UNLOCKS two blocks that read the same window and are `null` without it: " +
          "`unstable_tests` (which tests failed intermittently across the window rather than " +
          "consistently) and `directory_growth` (how each area moved between the two ENDPOINTS of " +
          "that window). The per-area comparisons against the PREVIOUS RUN — `directory_run_growth` " +
          "and `directory_runtime_growth` — need no branch and take none; they scope to the latest " +
          "run's own branch by construction, so a plain call already carries them.",
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
          "The one ask opens THREE blocks, each in its own grain: `spec_directory_files` for which " +
          "files carry the area's wall clock, `directory_run_file_growth` for which of them changed " +
          "SIZE since the previous run, and `directory_runtime_file_growth` for which of them " +
          "changed TIME. The last two are the answer to the dead end the area-grain comparisons " +
          "leave — `spec/models 412 → 459 (+47)`, but WHICH FILES did that — and they need no " +
          "second parameter. " +
          "Omit it and all three are `null`, meaning you did not ask — an area the run recorded " +
          "nothing for is `rows: []` instead, not an error. The two growth blocks are additionally " +
          "`null` when there is no previous run to compare this one against, which is the same " +
          "'not measured' the area-grain comparisons report.",
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
      unstable_test: {
        type: "string",
        description:
          "Open ONE row of the `unstable_tests` ranking — the cross-run flakiness ranking, which " +
          "counts how often a test failed across the window but not WHEN. Use a description " +
          "exactly as served in `unstable_tests.rows[].name`. Asking populates " +
          "`unstable_tests.unstable_test_runs` — that description's rows run by run in window " +
          "order, NEWEST RUN FIRST, up to 200, each with `test_run_id`, `commit_sha`, `branch`, " +
          "`ingested_at`, `outcome`, `duration_seconds`, `spec_file_path` and `line_number`, " +
          "plus the DESCRIPTION's own `recorded_count`, `reported_outcome_count`, " +
          "`unreported_outcome_count`, the window's `run_count` and the `limit` the row list was " +
          "cut at (the totals describe the whole window, not the returned page, so do not " +
          "re-derive them from `rows`). " +
          "This is the ONLY way to tell a regression from genuine flakiness: `run_count: 30`, " +
          "`failed_run_count: 4`, `outcome_words: [\"failed\", \"passed\"]` are IDENTICAL for " +
          "failures in runs 27–30 — a regression, so find the commit — and failures in runs 3, " +
          "11, 19 and 26 — flakiness, where there is no culprit commit. The sequence is not " +
          "derivable from anything else served: `history` has no per-test grain, and " +
          "`spec_file_examples`/`repeated_description_examples` carry `outcome` for the latest " +
          "run only. " +
          "MIND THE DIRECTION when you read those positions: element 0 is the MOST RECENT run in " +
          "the window, so the run a failure STARTED at is the LAST row of the leading failed " +
          "block, not the first. Read front-to-back as run 1 onwards and the regression above " +
          "looks like a flake that was fixed — the exact inversion, with no error to signal it. " +
          "The 200 cap drops the OLDEST rows for the same reason. Read the run off each row's " +
          "`commit_sha`/`test_run_id`, never off its index: a run that recorded nothing under " +
          "the description contributes no row and a description carried by two examples in one " +
          "run contributes two, so `rows` is not one entry per run. " +
          "`branch` IS REQUIRED WITH IT, unlike every other argument here: `unstable_tests` is " +
          "served only for a branch-narrowed window, so this parameter sent alone leaves the " +
          "whole containing block `null` and there is nothing to drill into — not an empty " +
          "`rows: []`, no block at all. " +
          "Omit it and the key is `null`, meaning you did not ask — a description the window " +
          "recorded nothing for is `rows: []` instead, not an error: identity here is semantic, " +
          "so a renamed test starts a NEW history and a stale bookmark is an ordinary way to " +
          "arrive.",
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
    const unstableTest = optionalString(args["unstable_test"], "unstable_test");
    const api = requireApiConfig(context.config);

    const body = await getJson(
      api,
      "/api/v1/repository",
      {
        branch,
        spec_directory: specDirectory,
        spec_file: specFile,
        repeated_description: repeatedDescription,
        unstable_test: unstableTest,
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
