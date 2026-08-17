import { requireApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { getJson } from "../support/specguard-api.js";
import { optionalBoolean, optionalString } from "./args.js";
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
 *
 * == `commit_sha` is not a sixth rung — it moves the ladder
 *
 * The five parameters above narrow what is served ABOUT a run that
 * `Api::V1::RepositoriesController#latest_test_run` had already chosen. This
 * one CHOOSES THAT RUN, which the controller states in those terms: `?branch=`
 * asks about a SERIES, this asks WHICH RUN. It is read once, in that memo, so
 * every run-grain block moves together — `latest_run` and its rollups, the
 * four RUN-GRAIN drill-ins (`spec_directory_files`, `spec_file_examples`,
 * `repeated_description_examples` and `unannotated_examples`, the flag-style
 * rung documented below), `shards`, both growth windows and
 * `previous_test_run`.
 *
 * That is four of the FIVE drill-ins on this tool, and the excluded one is
 * worth naming because it is the composition an agent will actually try:
 * `unstable_test_runs` is read over the BRANCH WINDOW (`history_runs`), not off
 * the anchored run, so it does not move with this parameter. Sent together,
 * `?commit_sha=` and `?unstable_test=` answer about different things on
 * purpose — one run, and the window that run sits in.
 *
 * Withholding it here withheld a capability that the tool was ALREADY
 * DISCLOSING THE NEED FOR. `branch`'s own description names the failure:
 * "`latest_run` always names the repository's newest run, which on a busy repo
 * may be on another branch". And `unstable_test`'s teaches `commit_sha` as the
 * canonical run handle — read the run off each row's `commit_sha`, never off
 * its index — while every `unstable_test_runs` row carries one. The bridge
 * handed shas out and accepted none back, with `additionalProperties: false`
 * refusing the argument before a request was made, so the agent that most needs
 * it — one that edits tests, pushes, waits for CI and re-reads SpecGuard to
 * check its own work — could not work around it. On a repository where anything
 * else pushed in between, it was silently answered about another commit.
 *
 * `renderText` is the whole body verbatim, so this bridge has been SERVING the
 * `run_anchor` block since the API shipped it — with its only informative state
 * structurally unreachable. `requested_commit_sha` was always `nil` through the
 * bridge, so every MCP call read `source: "default"`, `resolved: true`. A
 * disclosure block cannot disclose a fallback to a client that cannot make the
 * ask that falls back.
 *
 * TWO THINGS ARE STATED IN THE SCHEMA because neither is guessable from the
 * ladder. `history` is NOT re-anchored — it stays the recent runs, narrowed
 * only by `branch` — so the `history[0] == latest_run` identity holds on a
 * default call and is NOT expected to hold under an explicit ask; that is the
 * contract, and a client needing the identity back omits the parameter. And an
 * unknown sha DOES NOT 404: a stale bookmark, a pruned run and a commit whose
 * CI never reported are ordinary ways to arrive, so the endpoint falls back to
 * the newest run and SAYS SO (`source: "requested"`, `resolved: false`, the raw
 * ask kept in `requested_commit_sha`, `commit_sha`/`branch` naming what was
 * actually served). Nothing else about the response looks unusual, which is why
 * the schema tells the agent to read `run_anchor.resolved`.
 *
 * == `unannotated_examples` is the one that is a FLAG rather than a name
 *
 *   `latest_run.total_specs` − `annotated_specs` → `latest_run.unannotated_examples`
 *
 * The argument for forwarding it is the ladder's again — the parameter was
 * withheld by not being offered, `additionalProperties: false` refused it before
 * a request was made, and `renderText` has therefore been serving
 * `unannotated_examples: null` (the server's "you did not ask" spelling) to a
 * client structurally incapable of asking. What is new is WHOSE question it
 * answers. This is the adoption metric of Project Goals (SPGD-1): an agent told
 * to raise annotation coverage was served `annotated_ratio` and a `null`, so it
 * learned how far it had to go and could not name a single test to annotate. A
 * plain `curl` user could.
 *
 * ONE THING DIFFERS FROM ALL SIX SIBLINGS, and it is the reason this forward is
 * not a copy of the previous five. Every parameter above names a WHICH — which
 * branch, which commit, which area, which file, which description, which test —
 * because each opens the rows behind a LINE of a ranking the client had already
 * read. This one opens a POPULATION rather than a pick: the figure it drills out
 * of is a SUBTRACTION on the run itself, and a subtraction has no rows to have
 * keys, so there is nothing for the ask itself to NAME. So the server reads only
 * whether the parameter was NAMED, which `RequestedUnannotatedExamplesParam`
 * states outright — the value is not read, and THAT INCLUDES `false`:
 * `?unannotated_examples=false` opens the block exactly as `=true` does.
 *
 * That is a hazard on this side rather than a curiosity, and it is why the
 * argument is a BOOLEAN coerced with `optionalBoolean` and the query key is
 * built rather than stringified. `getJson` omits only `undefined`, so
 * `String(false)` would put `unannotated_examples=false` on the URL and open a
 * hundred-row block for the one caller who asked explicitly for it NOT to be
 * opened — the exact misreading the server's guard file exists to prevent, made
 * on the other side of the wire. The key is sent as `"true"` on an affirmative
 * ask and is `undefined` otherwise, so declining and omitting are the same wire
 * request. That matches how every other parameter here is declined: none of them
 * has an "off" value either.
 *
 * WHICH POPULATION IT OPENS IS NOT FIXED, and that is the half this file first
 * got wrong. `specguard` `55e3a09` made `?spec_file=` and `?spec_directory=`
 * narrow this block when either rides along with the flag — the same two
 * parameters that open their own drill-ins beside it — so the ask has FOUR
 * shapes rather than one: the whole run, one file, one area, or the AND of a
 * file and an area. The flag still names nothing, because the narrowing is named
 * by those two parameters and not by this one; what changed is that "the
 * population" is no longer a definite article. `SpecObservation.unannotated_in`
 * appends both predicates to the WHERE that the `COUNT(*) OVER ()` window of
 * `UNANNOTATED_POPULATION_COUNTS` rides, so `recorded_count` counts the NARROWED
 * population rather than the run's — and the controller echoes `spec_file` and
 * `spec_directory` back INSIDE the block, as the server read them and `null`
 * when not sent, for exactly that reason: `recorded_count` is the one figure
 * here a client reconciles against `total_specs - annotated_specs`, and a
 * silently narrowed count breaks that reconciliation. The echo is what makes the
 * count's population readable.
 *
 * ⭐ AND THE ONE ASK NOW OPENS TWO BLOCKS, THE SECOND OF WHICH IS A RANKING.
 * `specguard` `9df1b3d` added `latest_run.unannotated_directories` under this
 * SAME flag — no new parameter, no new value, nothing extra for a client to send
 * — so every call that already asks for the worklist is already being served the
 * map beside it. It answers what the worklist cannot: the worklist is WHICH
 * TESTS to go and annotate, and the map is WHERE THE DEBT IS, rolled up by area,
 * which is what a reader picks the next `?spec_directory=` narrowing FROM. That
 * is the same shape `spec_directory`'s own description states one parameter
 * over — one ask, several blocks, each in its own grain — so it is said here in
 * that form rather than in a new one.
 *
 * TWO CAPS UNDER ONE ASK, and the difference is the KIND of list rather than the
 * grain. `UNANNOTATED_EXAMPLES_LIMIT` is 100 and `UNANNOTATED_DIRECTORIES_LIMIT`
 * is 10, and the server's constant says why: the hundred caps a WORKLIST, sized
 * for a batch somebody opens, annotates and re-delivers in one sitting; the ten
 * caps a RANKING, which exists only to name where the debt is concentrated, and
 * a reader who cannot pick from ten areas is not helped by eighty. The ORDERS
 * differ for the same reason — the worklist is file-navigable, and the map is
 * `unannotated_count DESC, path ASC`: ranked by debt, with path as a tiebreak
 * only. A fully-annotated area is a REAL ROW here with `unannotated_count: 0`
 * against its real `recorded_count`, never an omission. Those rows sort last
 * COLLECTIVELY, so on a run with more areas than the cap they are cut and never
 * seen, but on a run inside the cap they ARE LISTED and listed is correct. So
 * `rows.size` is not a count of areas WITH debt — read each row's
 * `unannotated_count` for that; and `directory_count` counts EVERY area the run
 * touched, not every area with debt, and never `rows.size` either.
 *
 * ⭐ THE TWO KEYS OF THIS ONE BLOCK DISAGREE IN TWO PLACES, ON PURPOSE, and both
 * are counting traps rather than curiosities. `serialized_unannotated_directories`
 * discloses both at unusual length precisely because the machine-readable
 * consumer is the one that would otherwise discover them by arithmetic — and
 * this bridge IS that consumer.
 *
 * (a) SCOPE. `unannotated_examples.recorded_count` NARROWS with `?spec_file=` /
 * `?spec_directory=`; `unannotated_directories` stays WHOLE-RUN under both. So
 * under a narrowing the worklist's `recorded_count` is NOT the sum of the map's
 * `unannotated_count`s, AND NEITHER FIGURE IS WRONG: the first counts the one
 * area or file you named, the second ranks the whole run. The map is whole-run
 * BY DESIGN, because it is the thing a client picks a narrowing FROM and a map
 * that narrowed to the area you had already picked would answer nothing — one
 * row, echoing the parameter back. The sum is short of the run's total whenever
 * `directory_count > rows.size` besides, narrowing or no narrowing. This is why
 * the reconciliation rule above is scoped to the WORKLIST's count and to that
 * count alone.
 *
 * (b) NULL VERSUS EMPTY. On a run that recorded no per-example rows at all, with
 * the flag sent, `unannotated_examples` is a PRESENT block with `rows: []` and
 * `recorded_count: 0`, while `unannotated_directories` is `null`. That is not an
 * inconsistency to iron out. The sibling's zero is ambiguous by construction —
 * "fully annotated" and "recorded nothing at all" reach the same
 * `recorded_count: 0` there — and this key is how a client tells them apart: a
 * PRESENT map beside that zero means the run has a per-area grain and the zero
 * is the SUCCESS state; a `null` map means the run recorded nothing and the zero
 * is an ABSENCE of data. Serving `rows: []` here instead would spend a
 * distinction a client has no other way to make.
 *
 * THE `commit_sha` ROSTERS above and in README.md CORRECTLY STAY AT FOUR, and
 * the reason is the roster's UNIT, not anything about this block's shape. That
 * roster carries ONE REPRESENTATIVE KEY PER DRILL-IN PARAMETER, not one entry
 * per response key: `spec_directory` opens THREE blocks (see its own
 * description below), yet only `spec_directory_files` is on the roster —
 * `directory_run_file_growth` and `directory_runtime_file_growth` are absent
 * from it for exactly this reason, and the guard in
 * `test/tools/repository-overview.test.ts` enforces it that way, deriving the
 * obligation from the schema's PARAMETERS and mapping each to the single key it
 * represents. `unannotated_directories` is a SECOND BLOCK OF AN EXISTING
 * PARAMETER'S ASK and adds no parameter, so it is not a roster entry. It is at
 * run grain and does re-anchor, and is covered there by "`latest_run` and its
 * rollups".
 *
 * FOUR THINGS ARE STATED IN THE SCHEMA. It is at RUN GRAIN, so it moves with
 * `commit_sha` like everything else under `latest_run` — unlike `unstable_test`,
 * which does not. A FULLY-ANNOTATED run answers `rows: []` /
 * `recorded_count: 0` with 200, never a 404 and never the no-ask `null`: that is
 * the state the metric exists to reach, so an agent walking a repository to
 * completion must see the block go empty rather than watch it vanish at the
 * moment it succeeded and be unable to tell that from its own parameter having
 * been dropped. The pair above — that `spec_file`/`spec_directory` narrow this
 * population when they ride along, and are echoed back so the client can tell
 * which population `recorded_count` is of. And the second block this one ask
 * opens, with its own cap, its own ranking order and both of the disagreements
 * above, because a pass-through `renderText` puts that key in front of every
 * agent whether or not anything here has named it.
 *
 * == `delivery_health` and `credential_health` are that rule applied to the
 * == blocks that say WHETHER TO BELIEVE THE REST
 *
 * The sentence directly above is the whole argument, and until now it was
 * unapplied at the top level of the very same body. `Api::V1::RepositoriesController`
 * serves both blocks UNCONDITIONALLY — it says "SERVED ON EVERY RESPONSE" in
 * capitals at both sites — so `renderText` has been handing them to every MCP
 * agent since they shipped, while this description enumerated the response in
 * exhaustive detail and named neither.
 *
 * NOTHING HERE OPENS THEM, which is exactly why nothing here caught the
 * omission. Every other block this file discusses arrived attached to a
 * parameter, and the roster guard in `test/tools/repository-overview.test.ts`
 * derives its obligation from `inputSchema.properties` — so a block that adds no
 * property is structurally invisible to it, as `unannotated_directories` was one
 * section up. The only other check on this string is a `length >= 80` floor. The
 * schema is UNTOUCHED by this change for that reason: the two are response
 * blocks, not asks, and a reader must not be able to infer a flag that does not
 * exist.
 *
 * WHAT THEY ANSWER IS "WHY IS THIS DATA LYING TO ME", which is the one question
 * an agent cannot answer from any other key here. `delivery_health` is the
 * staleness verdict — `refusing?`, `last_rejection_at`, and the endpoint's own
 * refusal reasons per retained delivery — and without it a `latest_run` that is
 * days old reads as a suite nobody ran rather than a suite the platform stopped
 * accepting. `credential_health` covers the one failure `delivery_health`
 * structurally cannot: a 401 resolves no repository and writes no
 * `IngestRejection` row, so an auth-broken pipeline leaves every rejection
 * figure at zero. It reports the state anyway because it need not observe the
 * 401 — it owns the key row and stamped the instant the token was retired.
 *
 * A QUIET ANSWER IS A POSITIVE FINDING, and that is stated outright rather than
 * left to be inferred, on the controller's own reasoning at both sites: an agent
 * that is served `refusing: false` must be able to tell "nothing was refused"
 * from "SpecGuard does not track that", and the difference is not visible in the
 * value. A human reads the dashboard panels for this; an agent reads only what
 * this string told it to look for.
 *
 * TWO FURTHER KEYS ARE NAMED HERE FOR THE SAME REASON, both found by taking the
 * membership question as a GREP over the endpoint's top-level keys rather than
 * as a reading of this file. `api_key.last_used_at` is the claim the two health
 * blocks exist to CORRECT — it is stamped on the way in, before the payload is
 * looked at, so a repository whose every delivery is refused serves its freshest
 * timestamp beside its stalest run, and the controller answers that with
 * `acceptance_reported_by` / `rotation_reported_by` naming the keys that answer
 * what it cannot. Naming the correction and not the claim would have been half a
 * sentence. And the truncation contract, which is NOT the uniform family it looks like from the
 * key names: only eight lists have a `*_window` sibling at all, MOST lists under `latest_run`
 * carry an inline `limit` beside `rows` instead, four of those windows serve no bound of their
 * own, `rejections_window` serves a bound and no order, and the lists this census found carrying
 * no bound anywhere are `credential_health.keys` and BOTH `latest_run.shards` lists (`rows`,
 * ranked slowest-first off `TestRun#shard_durations`, and `per_shard`, in delivery order off
 * `#shard_reports`), each complete by construction. So the rule is stated in the direction that
 * stays true as the endpoint grows, and whose correctness does NOT depend on that list being
 * exhaustive: a bound BESIDE a list means a page, and no bound means the whole set. Quantifying
 * over the capped cases instead — "every ranking is capped, except..." — is what put a false
 * universal here twice, because the census that produced it counted lists that HAVE a bound and
 * never asked how many have none. It sends an agent looking for a disclosure that does not exist
 * and leaves it unable to tell "complete by construction" from "silently cut", which is the exact
 * misreading the two blocks above were named to prevent.
 *
 * == `suite_size_measured`, `shard_count` and `timed_shard_count` are that rule
 * == applied a FOURTH time, to the keys that say WHETHER TWO ROWS MAY BE
 * == DIFFERENCED AT ALL
 *
 * The same argument, the same blind spot, the same remedy — and the remaining
 * unapplied case. `serialized_history_row` in `Api::V1::RepositoriesController`
 * puts all three on EVERY `history[]` row, and `suite_size_measured` is served a
 * SECOND time on `latest_run`, deliberately from the same predicate so that a
 * single response body cannot describe one row twice and disagree with itself
 * (in the unfiltered window `history[0]` IS `latest_run`). Until now this string
 * named none of the three, while selling history differencing outright: the
 * `branch` parameter below tells an agent that consecutive all-branch rows "must
 * not be differenced", which teaches the differencing and names only the one
 * hazard that happens to be expressible as a parameter.
 *
 * THEY ARE ONE BLOCK BECAUSE THEY ARE ONE QUESTION. `suite_size_measured` says
 * whether a row is a measurement at all; `shard_count` is the denominator of
 * `total_specs` (a SUM over the shards RECORDED, and what `TestRun#assembled_like?`
 * reads to decide differenceability); `timed_shard_count` is the denominator of
 * `duration_seconds` (a MAX over the shards that REPORTED, whose absence lets a
 * client report the controller's "70% speedup produced entirely by telemetry
 * loss"). An agent that differences two rows without all three gets a number
 * wearing a SHA and a timestamp that make it read as a checked fact.
 *
 * THE LAST SENTENCE OF THE DESCRIPTION WAS ALSO WRONG IN ITS REACH, not merely
 * silent. "A null is 'not measured', never zero" routes a reader to NULLNESS as
 * the measured/not-measured signal, but `TestRun#suite_size_measured?` is
 * `total_specs_count.to_i.positive?` — so a run that reported zero tests serves a
 * NON-NULL `total_specs: 0` beside `suite_size_measured: false`. A reader obeying
 * the string's own stated rule reads that row as "measured, 0 tests" where the
 * server says "not a measurement". The sentence's true content about nulls is
 * kept; what is added is the bound, that the rule does not run backwards. The
 * controller serialized the boolean rather than leaving the client to re-derive
 * it from `total_specs` precisely so the two could not drift — and this bridge's
 * silence was forcing every MCP agent into exactly that re-derivation.
 *
 * THE SCHEMA IS UNTOUCHED, for the reason stated one section up: these are
 * RESPONSE keys, not asks, and a reader must not be able to infer a flag that
 * does not exist. And NO GUARD CAN CATCH A REGRESSION OF THIS CHANGE — every
 * roster guard in `test/tools/repository-overview.test.ts` opens with
 * `inputSchema.properties` and derives its obligation from a PARAMETER, so a
 * block that adds none is invisible to them by construction, and the only other
 * check on this string is a `length >= 80` floor. That is why the reasoning is
 * recorded here at this length: this comment is the only thing standing between
 * these three keys and a silent re-wording that drops them again.
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
    "All of those describe the repository's NEWEST run, which on a busy repository may be another " +
    "branch's: pass `commit_sha` to be answered about ONE named run instead — after pushing a " +
    "commit and waiting for CI, say — then read `run_anchor` to confirm which run you were served, " +
    "because an unknown sha falls back to the newest rather than erroring. " +
    "Pass `unannotated_examples: true` to list the individual tests SpecGuard CANNOT see — the " +
    "examples behind the annotated ratio, which is otherwise a percentage with nothing to act on — " +
    "and, in the same answer, which AREAS of the suite carry the most of them. " +
    "TWO BLOCKS COME BACK ON EVERY RESPONSE — no parameter to pass, no flag to set — and they " +
    "answer what everything above silently depends on: is SpecGuard still being fed? " +
    "`delivery_health` is why the figures may be STALE: `refusing` is a comparison of stamps, not a " +
    "live wire — true when the newest refusal is newer than the newest ACCEPTED run, and true when " +
    "nothing has ever been accepted — so read it with `last_rejection_at` and judge recency " +
    "yourself, because a repository refused once and quiet since still answers true. Each retained " +
    "rejection carries the endpoint's own reasons and, where the client reported one, the client " +
    "version that sent it. A `latest_run` from days ago beside a live rejection stream is a suite " +
    "SpecGuard STOPPED ACCEPTING, not a suite nobody ran. " +
    "`credential_health` covers the break that one structurally CANNOT see — a rejected key " +
    "resolves no repository and writes no rejection row, so an authentication-broken pipeline is " +
    "invisible to every rejection figure — by naming any key that was ROTATED and has not " +
    "authenticated since: a secret some pipeline has not picked up. " +
    "Read a quiet answer as a FINDING rather than a gap: `refusing: false` is 'nothing was refused' " +
    "and `rotated_and_unused: false` is 'no key is stranded', and neither is 'SpecGuard does not " +
    "track that'. " +
    "Do NOT read `api_key.last_used_at` as evidence anything was ACCEPTED — it is stamped on the " +
    "way in, before the payload is looked at, so a repository having every run thrown away still " +
    "reports it seconds ago; `delivery_health` answers acceptance and `credential_health` answers " +
    "rotation. " +
    "Where a bound sits beside a list, the list is a PAGE and not the set: `limit` next to " +
    "`rows`, or on that list's `*_window` block, which is also where the ORDER the cut was made " +
    "in is named when the list has one. What announces the cut varies too — `truncated`, " +
    "`bounded`, `returned` short of `limit`, or a `recorded_count` larger than the rows you were " +
    "served — so read the bound beside the list in front of you and never take a full-looking " +
    "ranking for the whole set. Where NO bound sits beside a list, it is everything there was: " +
    "`credential_health.keys` and both `latest_run.shards` lists are complete by construction, " +
    "which is a FINDING and not a disclosure someone forgot. " +
    "THREE MORE KEYS RIDE THE RESPONSE with no parameter to pass, and together they decide " +
    "WHETHER TWO RUNS MAY BE DIFFERENCED AT ALL — which is what the history is for. " +
    "`suite_size_measured` is served on `latest_run` AND on every `history[]` row, from the same " +
    "predicate at both sites so one run cannot disagree with itself: `false` means that run " +
    "reported NO tests, so its `total_specs` is a REPORT AND NOT A MEASUREMENT and a difference " +
    "taken against it describes the report rather than the suite. Never difference across a row " +
    "where it is false. " +
    "`shard_count` and `timed_shard_count` ride every `history[]` row and are the two " +
    "DENOMINATORS: difference `total_specs` only across rows of EQUAL `shard_count`, because that " +
    "count is a SUM over the shards RECORDED, and difference `duration_seconds` only across rows " +
    "of EQUAL `timed_shard_count`, because that figure is a MAX over the shards that REPORTED. " +
    "Ignore the second and a run whose four shards all reported, differenced against a run whose " +
    "two slowest were cancelled — identical `shard_count`, identical `suite_size_measured`, only " +
    "`timed_shard_count` differing — reads as a 70% speedup produced entirely by telemetry loss. " +
    "A half-reported run is the ORDINARY state, not an exotic one: every sharded run passes " +
    "through it while its shards are still arriving, and a job cancelled after two of four shards " +
    "leaves a half-sized row in the history permanently. " +
    "Use it to orient in an unfamiliar suite, to find what is slow before optimising, to find " +
    "what got slower or bigger since last time, to find which tests are flaky, to find " +
    "duplicated coverage before refactoring, to see annotation coverage, or to check that what " +
    "SpecGuard holds is still being delivered before trusting any of it. " +
    "Needs SPECGUARD_ENDPOINT and SPECGUARD_API_KEY. " +
    "Figures are null where CI did not report them — a null is 'not measured', never zero. That " +
    "rule is about NULLS and does not run backwards: a non-null figure is not thereby a " +
    "measurement. A run that reported zero tests serves a real `total_specs: 0` beside " +
    "`suite_size_measured: false`, so it is that boolean — never the nullness, and never a " +
    "re-derivation of your own from `total_specs` — that says whether the row measured a suite.",

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
          "SENT TOGETHER WITH `unannotated_examples`, it also narrows THAT worklist to this area — " +
          "its rows and its `recorded_count` both — and that block echoes the path back so you can " +
          "see which population its count is of. That is a narrowing of a block the FLAG opened, " +
          "not a fourth block this parameter opens. It narrows on the SAME equality this parameter " +
          "already uses for its own blocks — the immediate parent directory, never a prefix, so " +
          "`spec/models` does not reach `spec/models/orders`. " +
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
          "SENT TOGETHER WITH `unannotated_examples`, it also narrows THAT worklist to this file — " +
          "its rows and its `recorded_count` both — and that block echoes the path back so you can " +
          "see which population its count is of. " +
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
      commit_sha: {
        type: "string",
        description:
          "Anchor the whole answer on ONE run, naming it by commit sha. This is a DIFFERENT KIND " +
          "OF ASK from every other argument here: the five above narrow what is served ABOUT a run " +
          "that was already chosen for you, and this one CHOOSES THAT RUN. `branch` asks about a " +
          "SERIES; this asks WHICH RUN. Use a sha exactly as served in " +
          "`latest_run.commit_sha`, `history[].commit_sha` or " +
          "`unstable_tests.unstable_test_runs.rows[].commit_sha`. " +
          "Everything at run grain re-anchors together: `latest_run` and its five rollups, the " +
          "four RUN-GRAIN drill-ins (`spec_directory_files`, `spec_file_examples`, " +
          "`repeated_description_examples` and `unannotated_examples`), `shards`, both per-area " +
          "growth windows and `previous_test_run`. " +
          "`unstable_test_runs` is the one drill-in that does NOT move with " +
          "it: it is read over the branch window rather than off the anchored run, so sending " +
          "this with `unstable_test` still gives you that test across the whole window. " +
          "Use it when you need to be answered about a SPECIFIC run rather than whatever is " +
          "newest — after pushing a commit and waiting for CI, say, on a repository where anything " +
          "else may have pushed in between: `latest_run` otherwise names the repository's newest " +
          "run, which may be another branch's, with no error and no signal that you were answered " +
          "about someone else's commit. " +
          "`history` DOES NOT MOVE WITH IT. It stays the repository's recent runs, newest first, " +
          "narrowed only by `branch` — so the `history[0] == latest_run` identity that holds on a " +
          "default call is NOT expected to hold here: naming an older run makes `latest_run` a row " +
          "from the middle of `history`, or from behind its bound entirely. That is the contract, " +
          "not a bug. A client that needs the identity back omits this parameter. " +
          "AN UNKNOWN SHA DOES NOT ERROR — IT FALLS BACK AND SAYS SO, so read `run_anchor` rather " +
          "than trusting the shape of a successful response. A stale bookmark, a pruned run and a " +
          "commit whose CI never reported are ordinary ways to arrive, and all three are served " +
          "the repository's newest run with `source: \"requested\"`, `resolved: false` and the " +
          "raw ask echoed in `requested_commit_sha` — while `run_anchor.commit_sha`/`branch` name " +
          "the run ACTUALLY SERVED and will not equal what you asked for. THAT INEQUALITY IS THE " +
          "ONLY SIGNAL: check `run_anchor.resolved` before believing the run-grain blocks are " +
          "about your commit. `resolved` is false in exactly one case — you named a sha and are " +
          "not being served it — so it is `true` on a plain call, where there was no ask to fail. " +
          "Omit it and `run_anchor` reads `source: \"default\"`, `requested_commit_sha: null`. " +
          "A blank value — or `null` — is treated as NO ASK AT ALL rather than an error, but a " +
          "value of the WRONG TYPE (a number or an array, say) IS REFUSED BY NAME " +
          "(\"`commit_sha` must be a string.\") before any request is made — so send a " +
          "numeric-looking short sha such as `1234567` as a string, not as a number. No hex or " +
          "length checking is done: `commit_sha` is a plain string column written from whatever " +
          "CI reported, so short and long forms both work — pass the sha back exactly as it was " +
          "served.",
      },
      unannotated_examples: {
        type: "boolean",
        description:
          "Open a run's UNANNOTATED examples — the individual tests behind `latest_run`'s " +
          "`total_specs` MINUS `annotated_specs`, the subtraction the dashboard renders as " +
          "\"SpecGuard cannot see the other N tests\". Every other population this endpoint reports " +
          "can be walked down to the examples it counts; annotation coverage was the exception, so " +
          "`annotated_ratio` told you how far you had to go and not one test to annotate. " +
          "THIS ONE IS A FLAG, NOT A NAME — the only argument here that takes `true` rather than a " +
          "value. The others open the rows behind a LINE of a ranking and so carry that line's key; " +
          "this opens a POPULATION, which is a subtraction on the run and has no line to name. " +
          "WHICH population is still yours to choose, with parameters you already have: sent ALONE " +
          "the flag opens the WHOLE RUN, and sent TOGETHER WITH `spec_file` or `spec_directory` it " +
          "narrows to that file, that area, or — when both ride along — the AND of the two. Four " +
          "shapes from one flag. Those two keep opening their own blocks as well; narrowing this " +
          "one is additional, not instead. " +
          "Asking populates `latest_run.unannotated_examples` — up to 100 of the unannotated " +
          "examples OF WHATEVER YOU ASKED FOR, each with `name`, `file_path`, `line_number` and " +
          "`spec_file_path` (FOUR fields: no `duration_seconds` and no `outcome`, unlike the " +
          "per-example drill-ins above), plus that same population's own `recorded_count`, the " +
          "`limit` the row list was cut at, and `spec_file`/`spec_directory` ECHOED BACK as the " +
          "server READ them — `null` for each one you did not send. " +
          "READ THE ECHO BEFORE YOU READ THE COUNT. `unannotated_examples.recorded_count` — the " +
          "WORKLIST's count, and only that one; the map below deliberately does not narrow — is " +
          "the one figure here you would reconcile against `total_specs - annotated_specs`, and " +
          "it counts the NARROWED population whenever either echo is non-null — so that " +
          "reconciliation is expected to hold only when both echoes are `null`. The echo is what " +
          "tells the two cases apart, which is why the server sends it. " +
          "Do not re-derive `recorded_count` from `rows` in either case. Un-narrowed, this " +
          "population is routinely the entire run — a repository that has just installed the gem " +
          "has every test in it — so the cap is the normal case rather than the exotic one; a " +
          "narrowed ask is cut at the same 100. " +
          "THE ONE ASK OPENS TWO BLOCKS, each in its own grain: `latest_run.unannotated_examples` " +
          "for WHICH TESTS to go and annotate, and `latest_run.unannotated_directories` for WHERE " +
          "THE DEBT IS — one run's annotation debt rolled up by code AREA, which is what you pick " +
          "the next `spec_directory` narrowing FROM. Both come from this ONE flag: there is no " +
          "second parameter to send and no new value. " +
          "The map's rows carry `path`, `unannotated_count` and the `recorded_count` that area was " +
          "counted against (the operands, never a fraction), plus `directory_count` — EVERY area " +
          "the run touched, not every area with debt, and not `rows.size` — and its OWN `limit`, " +
          "which is 10 and NOT the worklist's 100. Two caps under one ask, and the difference is " +
          "the kind of list: 100 caps a WORKLIST to work through, 10 caps a RANKING to pick from. " +
          "The orders differ for the same reason — the worklist is file-navigable, the map is " +
          "ranked `unannotated_count` DESC with `path` as a tiebreak only. A fully-annotated area " +
          "is a real ROW with `unannotated_count: 0`, never an omission. Those rows sort last " +
          "COLLECTIVELY, so on a run with more areas than the cap they are cut and never seen, " +
          "but on a run inside the cap they ARE LISTED and listed is correct. So `rows.size` is " +
          "not a count of areas WITH debt — read each row's `unannotated_count`. " +
          "THE TWO BLOCKS DISAGREE IN TWO PLACES, ON PURPOSE — do not reconcile them by " +
          "arithmetic. " +
          "(1) SCOPE: `spec_file`/`spec_directory` narrow the WORKLIST and its `recorded_count`, " +
          "and the MAP stays WHOLE-RUN under both. So under a narrowing " +
          "`unannotated_examples.recorded_count` is NOT the sum of " +
          "`unannotated_directories.rows[].unannotated_count`, and NEITHER IS WRONG: one counts " +
          "the area or file you named, the other ranks the whole run. The map is whole-run by " +
          "design because it is what you choose a narrowing FROM — narrowed to the area you had " +
          "already picked it would answer nothing. The sum is short of the run's total whenever " +
          "`directory_count > rows.size` besides, narrowing or not. " +
          "(2) NULL VERSUS EMPTY: on a run that recorded no per-example rows at all, with the flag " +
          "sent, `unannotated_examples` is a PRESENT block with `rows: []` and `recorded_count: 0` " +
          "while `unannotated_directories` is `null`. That is a signal, not an inconsistency — " +
          "`recorded_count: 0` on the worklist means BOTH \"fully annotated\" and \"recorded " +
          "nothing\", and the map is how you tell them apart: a present map beside that zero means " +
          "the zero is the SUCCESS state, a `null` map means the run recorded nothing and the zero " +
          "is an ABSENCE of data. " +
          "BOTH BLOCKS ARE AT RUN GRAIN, so each MOVES WITH `commit_sha` like everything else " +
          "under `latest_run`, unlike `unstable_test` which does not. " +
          "A FULLY-ANNOTATED RUN IS NOT AN ERROR AND NOT A `null`: the worklist answers 200 with " +
          "`rows: []` and `recorded_count: 0`, because that is the state the metric exists to " +
          "reach — so a repository walked to completion shows the block EMPTY rather than gone. " +
          "A narrowing that matched nothing reads the SAME way and is never a 404: an unknown or " +
          "renamed path, a file that is already fully annotated, and a contradictory file-and-area " +
          "pair all answer `rows: []` with both narrowings echoed, which is an empty intersection " +
          "rather than a dropped parameter. " +
          "Omit the flag and BOTH keys are `null`, meaning you did not ask. `false` means the " +
          "same as omitting it and sends nothing at all: declining is not sending, which is how " +
          "every other argument here is declined too — none of them has an \"off\" value.",
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
    const commitSha = optionalString(args["commit_sha"], "commit_sha");
    // A BOOLEAN, and deliberately not stringified below. The server reads only
    // whether the key is PRESENT — `?unannotated_examples=false` opens the block
    // exactly as `=true` does — and `getJson` omits only `undefined`, so sending
    // `String(false)` would open a hundred-row block for the one caller who
    // asked explicitly for it not to be. See this file's header.
    const unannotatedExamples = optionalBoolean(
      args["unannotated_examples"],
      "unannotated_examples",
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
        unstable_test: unstableTest,
        commit_sha: commitSha,
        unannotated_examples: unannotatedExamples === true ? "true" : undefined,
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
