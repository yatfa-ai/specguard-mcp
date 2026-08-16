import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, ArgumentError, SpecGuardMcpError } from "../../src/errors.js";
import getRepositoryOverview from "../../src/tools/repository-overview.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

const ENV = { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

/** A response in the shape `Api::V1::RepositoriesController#show` renders. */
const BODY = JSON.stringify({
  repository: { id: 1, full_name: "acme/app", name: "app", registered_at: "2026-01-01T00:00:00Z" },
  api_key: { name: "ci", last_used_at: null },
  latest_run: {
    commit_sha: "abc123",
    branch: "main",
    total_specs: 20_000,
    annotated_specs: 1200,
    annotated_ratio: 0.06,
    duration_seconds: null,
    shards: null,
    suite_size_measured: true,
    // Served on every response. `null` is the server saying "you did not ask" —
    // it is populated only when `?spec_directory=` names an area.
    spec_directory_files: null,
    // The same contract, one rung down each: populated only when `?spec_file=`
    // names a file, and only when `?repeated_description=` names a group.
    spec_file_examples: null,
    repeated_description_examples: null,
    // And the flag-style one: populated only when `?unannotated_examples=` is
    // sent at all. `null` here is "you did not ask" — NOT "there are none",
    // which is served as a block with `rows: []`.
    unannotated_examples: null,
  },
  history_window: { branch_scope: "all_branches", branch: null, limit: 10, returned: 1 },
  history: [],
  branches_window: { returned: 1 },
  branches: [{ name: "main", run_count: 4, run_count_capped: false }],
});

/**
 * The same response as `BODY`, as the server renders it once the drill-down was
 * asked for — the ONE key that changes.
 *
 * The area totals are deliberately larger than the rows they sit beside:
 * `file_count` is 31 against 2 returned rows, because the server serves the
 * AREA's figures next to a row list it truncated at `limit`. A client that
 * re-derived either from `rows` would be reporting the page's figure under the
 * area's name, so this fixture is built so that mistake would be visible.
 */
const DRILLED_BODY = JSON.stringify({
  ...JSON.parse(BODY),
  latest_run: {
    ...JSON.parse(BODY).latest_run,
    spec_directory_files: {
      path: "spec/models",
      rows: [
        { path: "spec/models/user_spec.rb", total_seconds: 12.5, recorded_count: 40, timed_count: 40 },
        // `total_seconds` is null, never 0.0: every example in this file went
        // untimed, and a zero would assert a file that cost nothing.
        { path: "spec/models/order_spec.rb", total_seconds: null, recorded_count: 8, timed_count: 0 },
      ],
      file_count: 31,
      recorded_count: 900,
      timed_count: 640,
      limit: 25,
    },
  },
});

/**
 * `?spec_file=` answered — rung 3, and the ONE key that changes.
 *
 * Built on the same trap as `DRILLED_BODY`: `recorded_count` is 210 against 2
 * returned rows, because those counts are the FILE's population, evaluated
 * before the server cut the list at `limit`. `timed_count` is deliberately
 * lower than `recorded_count` — the file has examples CI never timed — so a
 * client that read either off `rows` would be reporting the page's figure under
 * the file's name.
 */
const FILE_DRILLED_BODY = JSON.stringify({
  ...JSON.parse(BODY),
  latest_run: {
    ...JSON.parse(BODY).latest_run,
    spec_file_examples: {
      path: "spec/models/user_spec.rb",
      rows: [
        {
          name: "validates the email format",
          file_path: "app/models/user.rb",
          line_number: 42,
          spec_file_path: "spec/models/user_spec.rb",
          duration_seconds: 3.25,
          outcome: "passed",
        },
        // `duration_seconds` is null, never 0.0: this example went untimed, and
        // a zero would assert an example that cost nothing.
        {
          name: "normalises the name",
          file_path: "app/models/user.rb",
          line_number: 58,
          spec_file_path: "spec/models/user_spec.rb",
          duration_seconds: null,
          outcome: "pending",
        },
      ],
      recorded_count: 210,
      timed_count: 190,
      limit: 50,
    },
  },
});

/**
 * `?repeated_description=` answered — rung 4, and the ONE key that changes.
 *
 * The group's members sit in DIFFERENT spec files, which is the whole point of
 * the ranking and the reason this rung is not reachable by walking the one
 * above: no single `spec_file` ask returns this list.
 */
const GROUP_DRILLED_BODY = JSON.stringify({
  ...JSON.parse(BODY),
  latest_run: {
    ...JSON.parse(BODY).latest_run,
    repeated_description_examples: {
      name: "is valid",
      rows: [
        {
          name: "is valid",
          file_path: "app/models/user.rb",
          line_number: 12,
          spec_file_path: "spec/models/user_spec.rb",
          duration_seconds: 0.4,
          outcome: "passed",
        },
        {
          name: "is valid",
          file_path: "app/models/order.rb",
          line_number: 9,
          spec_file_path: "spec/models/order_spec.rb",
          duration_seconds: null,
          outcome: "passed",
        },
      ],
      recorded_count: 88,
      timed_count: 71,
      limit: 25,
    },
  },
});

/**
 * `?unannotated_examples=` answered — the flag-style drill-in, and the ONE key
 * that changes.
 *
 * Built on the same trap as its siblings and then some: `recorded_count` is
 * 18_800 against 2 returned rows. That is not an exaggerated fixture — it is
 * `total_specs` (20_000) minus `annotated_specs` (1200) off `BODY`, so the
 * numbers agree with the run they describe. This population is routinely the
 * whole run, which makes the `limit` cut the NORMAL case here rather than the
 * exotic one, and a client folding `rows` would report 2 unannotated tests on a
 * suite with eighteen thousand.
 *
 * FOUR FIELDS PER ROW, not the six the other per-example blocks carry: no
 * `duration_seconds` and no `outcome`. The difference is asserted rather than
 * structural, so a field added server-side to match the siblings goes red here.
 */
const UNANNOTATED_DRILLED_BODY = JSON.stringify({
  ...JSON.parse(BODY),
  latest_run: {
    ...JSON.parse(BODY).latest_run,
    unannotated_examples: {
      rows: [
        {
          name: "validates the email format",
          file_path: "app/models/user.rb",
          line_number: 42,
          spec_file_path: "spec/models/user_spec.rb",
        },
        {
          name: "is valid",
          file_path: "app/models/order.rb",
          line_number: 9,
          spec_file_path: "spec/models/order_spec.rb",
        },
      ],
      recorded_count: 18_800,
      limit: 100,
    },
  },
});

/**
 * The SUCCESS state — every test in the run annotated — which is the state this
 * whole metric exists to reach and is NOT spelled like an absence.
 *
 * `rows: []` with `recorded_count: 0`, HTTP 200, with the key an OBJECT. The
 * server refuses to collapse this into the no-ask `null` for a stated reason: a
 * client walking a repository to completion would otherwise watch the block
 * vanish at the moment it succeeded, and could not tell that from its own
 * parameter having been dropped on the way. This fixture is what makes that
 * distinction testable on this side of the wire.
 */
const FULLY_ANNOTATED_BODY = JSON.stringify({
  ...JSON.parse(BODY),
  latest_run: {
    ...JSON.parse(BODY).latest_run,
    annotated_specs: 20_000,
    annotated_ratio: 1.0,
    unannotated_examples: { rows: [], recorded_count: 0, limit: 100 },
  },
});

describe("get_repository_overview — the request it makes", () => {
  it("GETs /api/v1/repository with the key as a Bearer token", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("passes ?branch= through when a branch is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({ branch: "main" }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository?branch=main");
  });

  it("omits ?branch= entirely for a blank one, rather than sending an empty filter", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({ branch: "  " }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("passes ?spec_directory= through when an area is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { spec_directory: "spec/models" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?spec_directory=spec%2Fmodels",
    );
  });

  it("omits ?spec_directory= entirely for a blank one, rather than opening a guaranteed-empty area", async () => {
    // `?spec_directory=` (blank) is "no ask" server-side, so sending it would be
    // a request for the drill-down that can only answer with nothing.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { spec_directory: "  " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("passes ?spec_file= through when a file is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { spec_file: "spec/models/user_spec.rb" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?spec_file=spec%2Fmodels%2Fuser_spec.rb",
    );
  });

  it("omits ?spec_file= entirely for a blank one, rather than opening a guaranteed-empty file", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run({ spec_file: "  " }, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("passes ?repeated_description= through when a group is asked for", async () => {
    // A description is free text rather than a path, so spaces and punctuation
    // are ordinary in it — the encoding is the load-bearing half of this one.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { repeated_description: "is valid & saves" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?repeated_description=is+valid+%26+saves",
    );
  });

  it("omits ?repeated_description= entirely for a blank one, rather than opening a guaranteed-empty group", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { repeated_description: "  " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("passes ?unstable_test= through when a flaky test is asked for", async () => {
    // Sent WITH `branch`, because that is the only way the parameter is of any
    // use: `unstable_tests` is served only for a branch-narrowed window, so the
    // block this drills into is `null` without one and there is nothing to
    // open. A description is free text rather than a path, so the encoding is
    // load-bearing here for the same reason it is on `repeated_description`.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { branch: "main", unstable_test: "is valid & saves" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?branch=main&unstable_test=is+valid+%26+saves",
    );
  });

  it("omits ?unstable_test= entirely for a blank one, rather than opening a guaranteed-empty history", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { unstable_test: "  " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("passes ?commit_sha= through when one run is named", async () => {
    // Sent alongside a drill-in, because the two compose rather than compete:
    // this one chooses WHICH RUN is described and `spec_file` opens one file OF
    // that run, so both keys have to survive onto the URL together. A sha is
    // not validated for shape server-side — `commit_sha` is a plain string
    // column written from whatever CI reported — so the short form is the
    // honest fixture here.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { commit_sha: "a1b2c3d", spec_file: "spec/models/user_spec.rb" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?spec_file=spec%2Fmodels%2Fuser_spec.rb&commit_sha=a1b2c3d",
    );
  });

  it("omits ?commit_sha= entirely for a blank one, rather than claiming an ask that must fall back", async () => {
    // Not merely tidy. The server reads the parameter as `.presence`, so a
    // blank one is "no ask" there too — but sending it would be asserting that
    // the two agree. They do, and a blank never leaves here: `test_runs`
    // validates the presence of `commit_sha`, so an empty ask is guaranteed to
    // match nothing, and forwarding it would risk a `run_anchor` reporting a
    // request that was never meaningfully made.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { commit_sha: "  " },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("passes ?unannotated_examples=true through when the block is asked for", async () => {
    // Sent alongside `commit_sha` because the two compose the way an agent will
    // actually use them: this block hangs off `latest_run`, so it is at RUN
    // GRAIN and re-anchors with the sha. "Which tests are unannotated in the run
    // I just pushed" is one call, and both keys have to survive onto the URL.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { unannotated_examples: true, commit_sha: "a1b2c3d" },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repository?commit_sha=a1b2c3d&unannotated_examples=true",
    );
  });

  it("sends NOTHING for `unannotated_examples: false`, rather than a value the server would read as an ask", async () => {
    // THE ONE TEST ON THIS TOOL THAT IS NOT A COPY OF ITS SIBLINGS, and the
    // reason the argument is a boolean coerced by `optionalBoolean` rather than
    // a string.
    //
    // The server reads only whether the parameter was NAMED —
    // `RequestedUnannotatedExamplesParam` says so outright: "THE VALUE IS NOT
    // READ, AND THAT INCLUDES `false`", so `?unannotated_examples=false` opens
    // the block exactly as `=true` does. And `getJson` omits a query entry only
    // when it is `undefined`. Stringify the boolean naively and `false` lands on
    // the URL as the four characters "false", which the server reads as an
    // affirmative ask and answers with up to a hundred rows — for the ONE caller
    // who asked explicitly for it not to be opened. Nothing errors; the response
    // is simply bigger than the client said it wanted.
    //
    // So the assertion is the WHOLE URL, not the absence of a substring: a bare
    // `doesNotMatch(/unannotated_examples/)` would also pass on a run() that
    // dropped the parameter entirely, which is the opposite defect.
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      { unannotated_examples: false },
      toolContext({ env: ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });

  it("does not double the slash when the endpoint carries a trailing one", async () => {
    const http = stubFetch({ body: BODY });

    await getRepositoryOverview.run(
      {},
      toolContext({ env: { ...ENV, SPECGUARD_ENDPOINT: "https://sg.example.com/" }, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");
  });
});

describe("get_repository_overview — the response it returns", () => {
  it("passes the body through untouched, nulls and all", async () => {
    // Every null in that body means "not measured" and is load-bearing: the
    // controller refuses to serialize a zero that would read as a measurement.
    // Reshaping here would discard exactly that distinction.
    const result = await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: BODY }).fetch }));

    assert.deepEqual(result.structured, JSON.parse(BODY));

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    assert.equal(latest["duration_seconds"], null);
    assert.equal(latest["shards"], null);
  });

  it("renders the same object as text, so the two halves cannot disagree", async () => {
    const result = await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: BODY }).fetch }));

    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("hands back the drill-down populated when an area was asked for", async () => {
    const result = await getRepositoryOverview.run(
      { spec_directory: "spec/models" },
      toolContext({ env: ENV, fetch: stubFetch({ body: DRILLED_BODY }).fetch }),
    );

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    const drilled = latest["spec_directory_files"] as Record<string, unknown>;

    assert.deepEqual(drilled, JSON.parse(DRILLED_BODY).latest_run.spec_directory_files);

    // The area's own totals, NOT the returned page's — served beside a row list
    // the server truncated at `limit`, and passed through as they arrived.
    assert.equal(drilled["file_count"], 31);
    assert.equal((drilled["rows"] as unknown[]).length, 2);

    // And the null survives the hop for the same reason every other null here does.
    assert.equal((drilled["rows"] as Record<string, unknown>[])[1]?.["total_seconds"], null);
  });

  it("hands back the file's examples populated when a file was asked for", async () => {
    const result = await getRepositoryOverview.run(
      { spec_file: "spec/models/user_spec.rb" },
      toolContext({ env: ENV, fetch: stubFetch({ body: FILE_DRILLED_BODY }).fetch }),
    );

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    const drilled = latest["spec_file_examples"] as Record<string, unknown>;

    assert.deepEqual(drilled, JSON.parse(FILE_DRILLED_BODY).latest_run.spec_file_examples);

    // The FILE's own totals, NOT the returned page's — served beside a row list
    // the server cut at `limit` by duration, and passed through as they arrived.
    assert.equal(drilled["recorded_count"], 210);
    assert.equal(drilled["timed_count"], 190);
    assert.equal((drilled["rows"] as unknown[]).length, 2);

    // And the null survives the hop for the same reason every other null here does.
    assert.equal((drilled["rows"] as Record<string, unknown>[])[1]?.["duration_seconds"], null);

    // Drilling one rung must not invent the others.
    assert.equal(latest["spec_directory_files"], null);
    assert.equal(latest["repeated_description_examples"], null);
  });

  it("hands back the group's examples populated when a repeated description was asked for", async () => {
    const result = await getRepositoryOverview.run(
      { repeated_description: "is valid" },
      toolContext({ env: ENV, fetch: stubFetch({ body: GROUP_DRILLED_BODY }).fetch }),
    );

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    const drilled = latest["repeated_description_examples"] as Record<string, unknown>;

    assert.deepEqual(
      drilled,
      JSON.parse(GROUP_DRILLED_BODY).latest_run.repeated_description_examples,
    );

    // The GROUP's own totals, NOT the returned page's.
    assert.equal(drilled["recorded_count"], 88);
    assert.equal(drilled["timed_count"], 71);
    assert.equal((drilled["rows"] as unknown[]).length, 2);

    // The members sit in different spec files — the property that makes this
    // rung unreachable from `spec_file`, preserved through the hop.
    const rows = drilled["rows"] as Record<string, unknown>[];
    assert.notEqual(rows[0]?.["spec_file_path"], rows[1]?.["spec_file_path"]);
    assert.equal(rows[1]?.["duration_seconds"], null);

    assert.equal(latest["spec_directory_files"], null);
    assert.equal(latest["spec_file_examples"], null);
  });

  it("hands back the run's unannotated examples populated when the flag was sent", async () => {
    const result = await getRepositoryOverview.run(
      { unannotated_examples: true },
      toolContext({ env: ENV, fetch: stubFetch({ body: UNANNOTATED_DRILLED_BODY }).fetch }),
    );

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    const drilled = latest["unannotated_examples"] as Record<string, unknown>;

    assert.deepEqual(drilled, JSON.parse(UNANNOTATED_DRILLED_BODY).latest_run.unannotated_examples);

    // The RUN's own population, NOT the returned page's — and here the two are
    // three orders of magnitude apart, because this list is capped as the normal
    // case rather than the exotic one.
    assert.equal(drilled["recorded_count"], 18_800);
    assert.equal((drilled["rows"] as unknown[]).length, 2);
    assert.equal(drilled["limit"], 100);

    // FOUR fields, not the per-example drill-ins' six. Asserted as a set so that
    // a `duration_seconds` or `outcome` added upstream is visible here rather
    // than passing silently under a `deepEqual` against a fixture updated to
    // match it.
    const rows = drilled["rows"] as Record<string, unknown>[];
    assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
      "file_path",
      "line_number",
      "name",
      "spec_file_path",
    ]);

    // Drilling this rung must not invent the others.
    assert.equal(latest["spec_directory_files"], null);
    assert.equal(latest["spec_file_examples"], null);
    assert.equal(latest["repeated_description_examples"], null);
  });

  it("keeps a fully-annotated run's EMPTY block an object, which is not the same answer as null", async () => {
    // The distinction the whole parameter turns on, and the one a pass-through
    // is uniquely well placed to protect: `null` means "you did not ask" and
    // `rows: []` means "you asked, and there are none" — the state the metric
    // exists to reach, served 200 and never as a 404.
    //
    // Any convenience the bridge might grow — defaulting an empty block to
    // `null`, dropping a key whose rows are empty — would collapse a repository
    // that finished the work into one that never asked, and an agent walking
    // annotation coverage to completion would read its own success as a dropped
    // parameter. So the assertion is `notEqual(null)` FIRST, then the shape.
    const result = await getRepositoryOverview.run(
      { unannotated_examples: true },
      toolContext({ env: ENV, fetch: stubFetch({ body: FULLY_ANNOTATED_BODY }).fetch }),
    );

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    const drilled = latest["unannotated_examples"] as Record<string, unknown>;

    assert.notEqual(drilled, null, "an empty population is a block with no rows, never a null");
    assert.deepEqual(drilled, { rows: [], recorded_count: 0, limit: 100 });
    assert.equal(latest["annotated_ratio"], 1.0);
  });

  it("asks for no area, and gets back null, when none was named", async () => {
    // The regression lock on the whole change, and it only means something if it
    // holds BOTH halves in the one place: the request must not carry a
    // `?spec_directory=` the agent never asked for, and the `null` answering it
    // must survive the hop unchanged.
    //
    // Asserting only the response would not reach the first half. `stubFetch`
    // answers with its canned body whatever the URL, so a `run()` mutated to
    // always send the parameter would leave a response-only assertion green —
    // the guard would be selecting on the response while claiming the request.
    const http = stubFetch({ body: BODY });

    const result = await getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repository");

    const latest = result.structured?.["latest_run"] as Record<string, unknown>;
    assert.equal(latest["spec_directory_files"], null);
    // Same lock, for the two rungs bridged after it — the URL assertion above is
    // the half that reaches them, since a `run()` that always sent either
    // parameter would still be handed this canned body.
    assert.equal(latest["spec_file_examples"], null);
    assert.equal(latest["repeated_description_examples"], null);
    // And the flag-style rung, whose `null` is the same "you did not ask" — the
    // spelling every MCP call got before this parameter was forwarded, back when
    // there was no way to ask at all.
    assert.equal(latest["unannotated_examples"], null);
  });
});

describe("get_repository_overview — failures an agent can act on", () => {
  it("names the missing variables instead of attempting a call", async () => {
    const http = stubFetch({ body: BODY });

    await rejects(getRepositoryOverview.run({}, toolContext({ env: {}, fetch: http.fetch })), /SPECGUARD_ENDPOINT/);

    assert.equal(http.requests.length, 0, "no request should be made without config");
  });

  it("explains a 401 as a key problem, since SpecGuard answers it flat by design", async () => {
    const error = await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ status: 401, body: '{"error":"unauthorized"}' }).fetch })),
      /rejected the API key/,
    );

    assert.match(error.message, /per-repository/);
  });

  it("explains a 404 as an endpoint problem", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ status: 404 }).fetch })),
      /root URL/,
    );
  });

  it("reports an unexpected status with the body", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ status: 503, body: "upstream down" }).fetch })),
      /503.*upstream down/s,
    );
  });

  it("says so when the endpoint answers 200 with something that is not JSON", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: stubFetch({ body: "<html>login</html>" }).fetch })),
      /not JSON/,
    );
  });

  it("names the endpoint when the deployment cannot be reached at all", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: failing })),
      /Could not reach https:\/\/sg\.example\.com/,
    );
  });

  it("rejects a branch of the wrong type", async () => {
    await rejects(getRepositoryOverview.run({ branch: 7 }, toolContext({ env: ENV })), /must be a string/);
  });

  it("rejects a spec_directory of the wrong type, naming it", async () => {
    // The server treats a non-String as no ask at all and renders the page it
    // rendered before the parameter existed — a silent wrong answer. Refusing
    // here tells the caller which argument it got wrong instead.
    await rejects(
      getRepositoryOverview.run({ spec_directory: ["spec/models"] }, toolContext({ env: ENV })),
      /`spec_directory` must be a string/,
    );
  });

  it("rejects a spec_file of the wrong type, naming it", async () => {
    // Same silent-wrong-answer trap as the sibling above, and the same remedy:
    // the message must name the field, because with six asks on this tool
    // "must be a string" alone does not say which one to fix.
    await rejects(
      getRepositoryOverview.run(
        { spec_file: ["spec/models/user_spec.rb"] },
        toolContext({ env: ENV }),
      ),
      /`spec_file` must be a string/,
    );
  });

  it("rejects a repeated_description of the wrong type, naming it", async () => {
    await rejects(
      getRepositoryOverview.run({ repeated_description: 7 }, toolContext({ env: ENV })),
      /`repeated_description` must be a string/,
    );
  });

  it("rejects an unstable_test of the wrong type, naming it", async () => {
    // The array shape specifically, because it is the one the server's own
    // guard singles out: `?unstable_test[]=x` would reach a `where(name: …)` as
    // an IN list and answer with SEVERAL tests' runs interleaved under a `name`
    // restating one — and two tests' outcomes shuffled together look exactly
    // like the alternation this block exists to show. Refused here, before a
    // request is made.
    await rejects(
      getRepositoryOverview.run({ unstable_test: ["is valid"] }, toolContext({ env: ENV })),
      /`unstable_test` must be a string/,
    );
  });

  it("rejects a commit_sha of the wrong type, naming it", async () => {
    // The array shape specifically, because it is the one the server's own
    // guard singles out: `?commit_sha[]=x` would reach a `where(commit_sha: …)`
    // on a plain string column as an IN list, which does not raise — it would
    // quietly anchor on whichever of several unrelated commits sorted newest
    // and serve every rollup, every drill-in and both growth windows against
    // it, under a `run_anchor` naming one sha the client asked for. That is the
    // silent wrong answer at its worst, and it is refused here before a request
    // is made.
    await rejects(
      getRepositoryOverview.run({ commit_sha: ["abc"] }, toolContext({ env: ENV })),
      /`commit_sha` must be a string/,
    );
  });

  it("discloses the run sequence's DIRECTION, which is the one ordering that changes the answer", () => {
    // The sequence is served newest run first: the window is
    // `Repository#recent_test_runs` (`created_at: :desc`) and
    // `SpecObservation.outcome_sequence_in` preserves that order rather than
    // re-sorting it. An agent reading `rows` front-to-back as run 1 onwards
    // sees a regression as failures at the START of the window that have
    // passed since — a fixed flake, the exact inversion — and if it then names
    // a culprit commit it names the newest failing run's SHA instead of the one
    // the failure began at. Nothing errors, which is why the prose has to say
    // it: this is the only drill-in on the tool whose list direction is the
    // payload rather than a presentation detail.
    //
    // What this guard is and is not: the direction is the SERVER's fact, so
    // this cannot verify the ordering itself — only that the description an
    // agent receives still discloses it. That is the honest limit here, and it
    // is worth pinning because the failure mode is a silent re-wording, the
    // same drift `test/readme.test.ts` exists to catch one surface over.
    const properties = getRepositoryOverview.inputSchema.properties ?? {};
    const description = (properties["unstable_test"] as { description?: string })?.description ?? "";

    assert.match(
      description,
      /NEWEST RUN FIRST/,
      "the parameter description must name which end of the sequence is the newest run",
    );
    assert.match(
      description,
      /LAST row of the leading failed block/,
      "naming the direction is not enough — the description must state the consequence an " +
        "agent acts on, that a failure's first run is the END of the leading failed block",
    );
  });

  it("discloses the three things about `commit_sha` an agent cannot guess from the ladder", () => {
    // Same shape and same honest limit as the guard above: these are the
    // SERVER's facts, so nothing here verifies the endpoint's behaviour — only
    // that the description an agent receives still discloses it. Each of the
    // three is a silent wrong answer if it drifts out, and none is derivable
    // from the five siblings, all of which narrow what is served about a run
    // that was already chosen.
    const properties = getRepositoryOverview.inputSchema.properties ?? {};
    const description = (properties["commit_sha"] as { description?: string })?.description ?? "";

    // 1. It CHOOSES THE RUN. Read as a sixth narrowing parameter it looks
    // redundant beside `branch`, and an agent that wants one run would reach
    // for the branch name — which re-anchors nothing and answers about the
    // newest run regardless. The controller draws the line in these terms.
    assert.match(
      description,
      /SERIES.*WHICH RUN|WHICH RUN.*SERIES/s,
      "the description must draw the line the controller draws — `branch` asks about a SERIES, " +
        "this asks WHICH RUN — because nothing in the other five suggests a parameter that moves " +
        "the anchor rather than narrowing what hangs off it",
    );

    // 2. `history` DOES NOT MOVE. Every other run-grain block does, so an agent
    // that reasonably generalises will read `history[0]` as the run it asked
    // for and difference the wrong pair of rows.
    assert.match(
      description,
      /`history` DOES NOT MOVE WITH IT/,
      "the description must state that `history` is not re-anchored, so the " +
        "`history[0] == latest_run` identity is not expected to hold under an explicit ask",
    );

    // 3. An unknown sha FALLS BACK rather than erroring, and the response is
    // shaped exactly like a success. This is the one that costs an agent its
    // answer silently: no 404, no empty block, just another run's numbers.
    assert.match(
      description,
      /run_anchor\.resolved/,
      "naming the fallback is not enough — the description must name the field an agent reads " +
        "to detect it, because a fallback response is otherwise indistinguishable from a hit",
    );
  });

  it("names every run-grain drill-in in `commit_sha`'s re-anchoring list, derived from the schema", () => {
    // The instrument whose absence shipped a self-contradicting schema once.
    // `commit_sha`'s description closes its enumeration — it lists what
    // re-anchors and then names `unstable_test_runs` as "the one drill-in that
    // does NOT move with it". A drill-in added to the tool and left out of that
    // list is therefore not merely undocumented: the closed list plus the
    // stated exception tells an agent it does NOT re-anchor, which is the
    // opposite of true, while the new parameter's own description says it does.
    // Two descriptions on the same `inputSchema` disagreeing about re-anchoring
    // is the product's core artifact being wrong, and the composition an agent
    // actually sends — a drill-in together with `commit_sha` — is exactly the
    // one they disagree about.
    //
    // Nothing else here can see that. `test/readme.test.ts` derives its
    // assertions from `TOOLS` and so catches a MISSING row; a stale ENUMERATION
    // inside a description is prose, green under every existing guard. So this
    // guard derives the obligation from the schema rather than transcribing the
    // list a second time: every property that is not in the exception set below
    // must have its response key named in `commit_sha`'s description. Adding a
    // sixth drill-in without touching that prose fails here. Adding one that
    // genuinely does not re-anchor still passes — but only by an explicit,
    // reviewable edit to `NOT_RUN_GRAIN_DRILL_INS`, which is the point.
    const properties = getRepositoryOverview.inputSchema.properties ?? {};
    const description = (properties["commit_sha"] as { description?: string })?.description ?? "";

    // The three properties that are NOT run-grain drill-ins, each for a reason
    // stated in its own description: `branch` narrows `history` (a series, not
    // a run), `commit_sha` IS the anchor rather than something anchored, and
    // `unstable_test` reads the branch window (`history_runs`) rather than the
    // anchored run — the documented exception the sentence after the list names.
    const NOT_RUN_GRAIN_DRILL_INS = new Set(["branch", "commit_sha", "unstable_test"]);

    // The response key each drill-in parameter opens. Keys, not parameter
    // names, because the description enumerates what MOVES — response blocks —
    // and for three of the four the two spellings differ.
    const RESPONSE_KEY: Record<string, string> = {
      spec_directory: "spec_directory_files",
      spec_file: "spec_file_examples",
      repeated_description: "repeated_description_examples",
      unannotated_examples: "unannotated_examples",
    };

    const drillIns = Object.keys(properties).filter((name) => !NOT_RUN_GRAIN_DRILL_INS.has(name));

    // Guard the guard: a new parameter with no entry in the map above would
    // otherwise be skipped silently, which is the same blind spot one level up.
    assert.deepEqual(
      drillIns.filter((name) => !(name in RESPONSE_KEY)),
      [],
      "every run-grain drill-in parameter needs its response key in RESPONSE_KEY, or an " +
        "explicit entry in NOT_RUN_GRAIN_DRILL_INS saying why it does not re-anchor",
    );

    for (const name of drillIns) {
      assert.ok(
        description.includes(`\`${RESPONSE_KEY[name]}\``),
        `\`commit_sha\`'s description must name \`${RESPONSE_KEY[name]}\` in its re-anchoring ` +
          "list — the list is closed and followed by a stated exception, so a block left out of " +
          "it reads to an agent as a block that does NOT move with the anchor",
      );
    }

    // And the count in the prose, which is the half a per-name loop cannot see:
    // the list can name all four while the sentence introducing it still says
    // "three", and an agent reading a count that disagrees with the list it
    // introduces has no way to tell which half is stale.
    assert.match(
      description,
      new RegExp(`${["", "one", "two", "three", "four", "five", "six"][drillIns.length]} RUN-GRAIN drill-ins`, "i"),
      `the description must introduce its list with the number of run-grain drill-ins the tool ` +
        `actually documents (${drillIns.length}), not a count left over from before the last one ` +
        "was added",
    );
  });

  it("points `commit_sha` at response paths that actually exist", () => {
    // The three guards above pin the FACTS. This one pins the PATH, because a
    // description can state every fact correctly and still hand the agent a
    // key that resolves to nothing — and that failure is invisible to a
    // fact-shaped assertion, which is how it survived the first round here.
    //
    // The specific trap: `unstable_test_runs` is an OBJECT (`name`, `rows`,
    // and the window's counters), not an array. Its shas live one level down,
    // on `rows[]`. Writing `unstable_test_runs[].commit_sha` indexes the
    // object and finds nothing, and it is precisely the path an agent has to
    // follow to use this parameter for the flakiness work it was built for.
    const properties = getRepositoryOverview.inputSchema.properties ?? {};
    const description = (properties["commit_sha"] as { description?: string })?.description ?? "";

    assert.match(
      description,
      /`unstable_tests\.unstable_test_runs\.rows\[\]\.commit_sha`/,
      "the description must name the sha's real home — `unstable_test_runs` is an object whose " +
        "shas hang off `rows[]`, so the `[]` belongs after `rows` and nowhere else",
    );
    assert.doesNotMatch(
      description,
      /unstable_test_runs\[\]/,
      "`unstable_test_runs[]` subscripts an object: this repo reserves `[]` for arrays " +
        "(`unstable_tests.rows[].name` is written that way for exactly that reason), so the bare " +
        "form is a path that resolves to nothing",
    );
  });

  it("rejects an unannotated_examples that is not a boolean, naming it", async () => {
    // The STRING shape specifically, because it is the one an agent will
    // actually produce: every other argument on this tool is a string, and
    // `"false"` is the spelling a client copying the pattern reaches for. It is
    // also the worst one to let through. The server reads only whether the
    // parameter was named, so a forwarded `"false"` would open the block for a
    // caller who spelled out the opposite — and unlike a bad `commit_sha`, there
    // is no `run_anchor` anywhere in the response to disclose what happened.
    // Refused before a request is made, so the ambiguity never reaches the wire.
    await rejects(
      getRepositoryOverview.run({ unannotated_examples: "false" }, toolContext({ env: ENV })),
      /`unannotated_examples` must be a boolean/,
    );
  });

  it("discloses what an agent cannot guess about `unannotated_examples` from the six siblings", () => {
    // Same shape and same honest limit as the two guards above: these are the
    // SERVER's facts, so nothing here verifies the endpoint's behaviour — only
    // that the description an agent receives still discloses it.
    const properties = getRepositoryOverview.inputSchema.properties ?? {};
    const parameter = properties["unannotated_examples"] as {
      type?: string;
      description?: string;
    };
    const description = parameter?.description ?? "";

    // 0. A BOOLEAN in the advertised schema, not merely in the coercion. This is
    // the half a client reads before calling, and the six siblings are all
    // strings — so an agent generalising from them sends `"true"`, which the
    // coercion refuses. Advertising the type is what stops that call being made.
    assert.equal(
      parameter?.type,
      "boolean",
      "the schema must advertise a boolean: `false` MUST be expressible as a value that sends " +
        "nothing, and a string parameter has no such value — the server reads any present key as " +
        "an ask",
    );

    // 1. WHERE THE ANSWER LANDS. Two of the six siblings answer somewhere other
    // than where their ranking sits, so the landing key is not inferable, and an
    // agent that guesses `unannotated_examples` at the top level reads the
    // absence of a key as an empty answer.
    assert.match(
      description,
      /`latest_run\.unannotated_examples`/,
      "the description must name the key the answer lands under",
    );

    // 2. IT MOVES WITH `commit_sha`. Whether a drill-in re-anchors is decided
    // per block on this endpoint — `unstable_test_runs` is read over the branch
    // window and does NOT move — so an agent that has read that exception has
    // positive reason to doubt this one, and "which tests were unannotated in
    // the run I just pushed" is the question it will ask.
    assert.match(
      description,
      /MOVES WITH `commit_sha`/,
      "the description must state that this block re-anchors with `commit_sha`, because its " +
        "sibling `unstable_test_runs` explicitly does not",
    );

    // 3. THE SUCCESS STATE IS NOT AN ABSENCE. This is the one that costs an
    // agent its answer silently: a fully-annotated run answers 200 with
    // `rows: []`, and an agent expecting a 404 or a `null` to mean "done" reads
    // the finished state as its own parameter having been dropped.
    assert.match(
      description,
      /`rows: \[\]`/,
      "the description must state that a fully-annotated run answers with an empty row list, " +
        "not an error and not the no-ask `null` — that is the state the metric exists to reach",
    );

    // 4. `false` SENDS NOTHING. Stated because the alternative is a silent
    // EXTRA answer rather than a missing one: nothing errors, the response is
    // simply bigger than the client asked for, on every request it makes.
    assert.match(
      description,
      /`false` means the same as omitting it/,
      "the description must say that a false flag sends nothing at all, since the server would " +
        "read a forwarded `false` as an affirmative ask",
    );
  });

  it("blames the ARGUMENT for a bad type, not the deployment", async () => {
    // Note the context: no endpoint, no key, no `ENV` at all. The seven
    // coercions run before `requireApiConfig`, so this refusal happens on a
    // server where no deployment could have been contacted — which
    // is exactly why the class it throws matters.
    const error = await rejects(
      getRepositoryOverview.run({ branch: 7 }, toolContext()),
      /`branch` must be a string/,
    );

    assert.ok(error instanceof ArgumentError, `expected an ArgumentError, got ${error.name}`);

    // The leg that makes this bite. Without it the example passes against the
    // code this ticket exists to change, and pins the defect instead of the fix:
    // `ApiError` is read elsewhere in this codebase as "the deployment
    // misbehaved" (`specguard-api.ts:127` branches on it), so any consumer that
    // grows a retry or a "SpecGuard may be down" message off that class would
    // apply it to the agent's own malformed argument, which no retry can fix.
    assert.ok(
      !(error instanceof ApiError),
      "a wrong-typed argument is not the deployment refusing — nothing was contacted",
    );

    // Still an expected failure rather than a defect, so it crosses `runTool`'s
    // boundary as the agent's own fixable mistake.
    assert.ok(error instanceof SpecGuardMcpError);
    assert.doesNotMatch(error.message, /bug in the bridge/);
  });
});

/**
 * Every one of these messages ends by telling the operator to go and check the
 * endpoint variable — so each has to name the variable they actually set.
 *
 * The endpoint check in `requireApiConfig` learned this first; the HTTP client
 * one layer out did not, and said `SPECGUARD_ENDPOINT` unconditionally. Someone
 * who followed the SPGD-310 brief and set `SPECGUARD_URL` was sent to fix a
 * variable that does not exist in their config. These pin the whole set rather
 * than the one message that prompted the fix, because the next HTTP tool
 * inherits `ApiConfig` and should inherit the naming with it.
 */
describe("get_repository_overview — diagnostics name the variable the operator set", () => {
  const VIA_ALIAS = { SPECGUARD_URL: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" };

  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;

  const cases: ReadonlyArray<{ what: string; context: () => Parameters<typeof getRepositoryOverview.run>[1]; expect: RegExp }> = [
    {
      what: "unreachable deployment",
      context: () => toolContext({ env: VIA_ALIAS, fetch: unreachable }),
      expect: /Check SPECGUARD_URL and that the deployment is reachable/,
    },
    {
      what: "404",
      context: () => toolContext({ env: VIA_ALIAS, fetch: stubFetch({ status: 404 }).fetch }),
      expect: /Check that SPECGUARD_URL is the deployment's root URL/,
    },
    {
      what: "200 with a non-JSON body",
      context: () => toolContext({ env: VIA_ALIAS, fetch: stubFetch({ body: "<html>login</html>" }).fetch }),
      expect: /Check that SPECGUARD_URL points at a SpecGuard deployment/,
    },
  ];

  for (const { what, context, expect } of cases) {
    it(`names SPECGUARD_URL, not SPECGUARD_ENDPOINT, for ${what}`, async () => {
      const error = await rejects(getRepositoryOverview.run({}, context()), expect);

      assert.doesNotMatch(error.message, /SPECGUARD_ENDPOINT/);
    });
  }

  it("still says SPECGUARD_ENDPOINT when that is the variable in use", async () => {
    await rejects(
      getRepositoryOverview.run({}, toolContext({ env: ENV, fetch: unreachable })),
      /Check SPECGUARD_ENDPOINT and that the deployment is reachable/,
    );
  });
});
