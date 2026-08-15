# specguard-mcp

> The MCP bridge to [SpecGuard](https://github.com/yatfa-ai/specguard) — gives an AI agent the suite
> intelligence behind a very large test suite as tools.

`specguard-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects
an MCP-capable agent (Claude Code, Claude Desktop, …) to SpecGuard, so the agent can ask what a
suite covers, what it costs to run and where the gaps are — without a line of HTTP or auth code in
its prompt.

SpecGuard is built [primarily for AI coding agents](https://github.com/yatfa-ai/specguard); this
bridge is how an agent reaches it without scraping a web UI.

> **Status: bootstrap.** Two tools ship today, each wrapping a capability that already exists. The
> toolset **grows gradually** — see [Adding a tool](#adding-a-tool). It is not published to npm yet;
> install from a checkout.

## Install

```bash
git clone https://github.com/yatfa-ai/specguard-mcp.git
cd specguard-mcp && npm install && npm run build
```

Requires Node.js 20 or newer.

## Configure

Nothing is required to *start* the server. Each tool asks for what it needs when it is called, so a
missing variable comes back as one readable sentence in a tool result — never as a server that
refuses to boot and takes the tools that needed no configuration down with it.

| Variable | Needed by | Default | What it is |
| --- | --- | --- | --- |
| `SPECGUARD_ENDPOINT` | `get_repository_overview` | — | your SpecGuard instance's root URL, **including the scheme** — e.g. `https://specguard.example.com`, or `http://localhost:3000`. A value with no scheme is refused by name (`SPECGUARD_ENDPOINT is not a usable URL: "sg.example.com"`) rather than surfacing later as an opaque failure. `SPECGUARD_URL` is accepted as an alias, and is the name every message uses when it is the one you set. A blank value counts as unset, so leaving `SPECGUARD_ENDPOINT` empty in a templated config falls through to `SPECGUARD_URL` instead of suppressing it |
| `SPECGUARD_API_KEY` | `get_repository_overview` | — | an agent/CI API key (`sgk_…`) issued by that deployment |
| `SPECGUARD_LINT_COMMAND` | `lint_intent_annotations` | `specguard-lint` | the command that runs the linter. Most Ruby projects need `bundle exec specguard-lint` |
| `SPECGUARD_TIMEOUT_MS` | HTTP tools | `30000` | how long a call to SpecGuard may take |

`SPECGUARD_ENDPOINT` and `SPECGUARD_API_KEY` are the same variables
[`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec) uses to ship a run, so a repository
that already posts telemetry to SpecGuard already has them.

Register it with your MCP client — for Claude Code:

```json
{
  "mcpServers": {
    "specguard": {
      "command": "node",
      "args": ["/path/to/specguard-mcp/dist/bin/specguard-mcp.js"],
      "env": {
        "SPECGUARD_ENDPOINT": "https://specguard.example.com",
        "SPECGUARD_API_KEY": "sgk_…",
        "SPECGUARD_LINT_COMMAND": "bundle exec specguard-lint"
      }
    }
  }
}
```

## The tools

### `lint_intent_annotations`

Validates the `@intent:` annotations in a Ruby project's spec files against the
[OpenTestIntent](https://github.com/yatfa-ai/open-test-intent) schema, by running that project's own
`specguard-lint --json`. Findings come back as data — file, line, failure kind, every violated rule
— rather than as a prose report to regex.

| argument | |
| --- | --- |
| `project_dir` | the project to lint; defaults to the server's working directory. A path that does not exist, or is not a directory, is refused by name — never reported as a missing linter |
| `paths` | specific spec files, relative to `project_dir`; omit to check all of them. An empty list is an error rather than a synonym for "everything", because a run that selected nothing must not come back clean |
| `changed` | check only what differs from the merge base with the default branch — CI's mode |
| `base` | diff `changed` against this ref instead |

Needs no SpecGuard deployment and no API key. A **missing** annotation is never a failure: adoption
is gradual by design, so a suite with no annotations lints clean.

**The exit code is a verdict, and the mapping matters.** `specguard-lint` exits `0` clean, `1` on a
malformed annotation, and `2` when it could not do its job. Exit `1` comes back as a **successful**
tool call carrying findings — an agent told "the tool failed" retries the tool, where an agent handed
a finding fixes the annotation. Only exit `2` is a tool error, and it carries the linter's stderr,
because the gem deliberately emits no document on that path.

### `get_repository_overview`

Asks SpecGuard what a repository's suite looks like **without running it** — the cold-start question
from Project Goals. One call returns the latest CI run (spec counts, annotated ratio, wall-clock and
per-shard cost), where that run spent its time (heaviest files, heaviest directories, slowest
individual examples with file and line), which descriptions are repeated across the suite (the
overcoverage ranking — one description carried by many examples, and which files it is spread over),
which areas grew or shrank and which got slower or faster since the previous run on the same branch
(the per-area comparisons, at both the example-count grain and the runtime grain), the recent run
history, and the branches that have runs. Pass `branch` for two more: which tests fail intermittently
rather than consistently (the cross-run flakiness ranking) and how the areas moved across the whole
branch window rather than between the last two runs.

| argument | |
| --- | --- |
| `branch` | narrow the run **history** to one branch, for a real growth series — and unlock `unstable_tests` and `directory_growth`, which read the same window |
| `spec_directory` | open ONE of the heaviest directories and list the spec files inside it |
| `spec_file` | open ONE of the heaviest spec files and list the individual examples inside it |
| `repeated_description` | open ONE repeated description and list the examples that all share it |
| `unstable_test` | open ONE flaky test and list its outcome run by run across the window, newest run first (needs `branch`) |

`branch` narrows `history` only — `latest_run` always names the repository's newest run, which on a
busy repo may be on another branch. That is a property of the endpoint, not of this bridge.

`branch` is also the gate on the two blocks read over that same window, and they are `null` without
it: `unstable_tests` (which tests failed intermittently across the window rather than consistently)
and `directory_growth` (how each area moved between the two **endpoints** of the window). The
per-area comparisons against the **previous run** — `directory_run_growth` at the example-count
grain and `directory_runtime_growth` at the runtime grain — are a different question and take no
branch at all: they scope to the latest run's own branch by construction, so a plain unparameterised
call already carries them. The two grains are independent, which is why both ship: making an
existing spec slow adds zero examples and shows up only in the runtime pair, and splitting one slow
spec into four fast ones is `+3` examples and *less* time.

`spec_directories` ranks the heaviest areas but stops at the area grain, so it says *where* the time
went and not *which files* spent it. `spec_directory` is the next question: pass a path exactly as
served in `latest_run.spec_directories.rows[].path` and `latest_run.spec_directory_files` opens with
the files in that one directory (`total_seconds`, `recorded_count`, `timed_count` each), plus the
**area's** own `file_count`/`recorded_count`/`timed_count` and the `limit` the row list was cut at —
those totals describe the whole area, not the returned page, so don't re-derive them from `rows`.
Omit the argument and the key is `null`, meaning *you did not ask*; an area the run recorded nothing
for answers `rows: []` rather than an error, so a renamed or deleted directory is an empty result and
not a failure.

That one ask opens **three** blocks, each in its own grain: `latest_run.spec_directory_files` for
which files carry the area's wall clock, `directory_run_file_growth` for which of them changed size
since the previous run, and `directory_runtime_file_growth` for which of them changed time. The last
two are the answer to the question the area-grain comparisons dead-end on — `spec/models 412 → 459
(+47)`, but *which files did that* — so they need no second parameter.

`spec_files` ranks the heaviest files but stops at the file grain, so it says *which files* cost the
most and not *which examples* inside them spent it. `spec_file` is the next question: pass a path
exactly as served in `latest_run.spec_files.rows[].path` and `latest_run.spec_file_examples` opens
with up to 50 of that file's individual examples, cut by **duration** (`name`, `file_path`,
`line_number`, `spec_file_path`, `duration_seconds`, `outcome` each), plus the **file's** own
`recorded_count`/`timed_count` and the `limit` the row list was cut at — those totals describe the
whole file, not the returned page, so don't re-derive them from `rows`. Omit the argument and the
key is `null`, meaning *you did not ask*; a path that matched nothing answers `rows: []` rather than
an error, so a renamed or deleted spec file and a stale bookmark are empty results and not failures.

`repeated_descriptions` ranks the descriptions carried by the most examples — the overcoverage
ranking — but names the description and the files it was seen in, not *which* examples say the same
thing. `repeated_description` is the next question: pass a description exactly as served in
`latest_run.repeated_descriptions.rows[].name` and `latest_run.repeated_description_examples` opens
with up to 25 of that group's members (the same six fields), plus the **group's** own
`recorded_count`/`timed_count` and the `limit` the row list was cut at — again totals for the whole
group and not for the returned page. This is the **only** way to reach a group's members:
`slowest_examples` is the run-wide top ten and rarely contains them, and walking `spec_file` over
each path in the row's `files_seen` is N unrelated lists each cut by duration, with no guarantee the
group's members survive the cut in any of them. Omit the argument and the key is `null`; a
description that matched nothing answers `rows: []`, so a test renamed since and an edited
description are empty results and not failures.

`unstable_tests` ranks the tests that failed intermittently across the branch window, but a row
carries `run_count`, `failed_run_count` and `outcome_words` — and those three figures are
*identical* for four failures in runs 27–30 and four failures in runs 3, 11, 19 and 26. The first is
a **regression** and the work is to find the commit; the second is genuine **flakiness** and the work
is quarantine or shared state. `unstable_test` is the next question: pass a description exactly as
served in `unstable_tests.rows[].name` and `unstable_tests.unstable_test_runs` opens with that
description's rows run by run in window order, **newest run first**, up to 200 (`test_run_id`,
`commit_sha`, `branch`, `ingested_at`, `outcome`, `duration_seconds`, `spec_file_path`,
`line_number` each), plus the **description's** own
`recorded_count`/`reported_outcome_count`/`unreported_outcome_count`, the window's `run_count` and
the `limit` the row list was cut at.

Note the two ways it differs from the drill-ins above. The answer lands **inside** the flakiness
block — `unstable_tests.unstable_test_runs`, not under `latest_run.*` — and `branch` is a hard
prerequisite rather than a suggestion: `unstable_tests` is `null` without it, so `unstable_test` sent
alone leaves no block to drill into at all, and not an empty `rows: []` either. Omit the argument and
the key is `null`; a description the window recorded nothing for answers `rows: []`, so a renamed
test — which starts a new history under the project's semantic identity rule — is an empty result and
not a failure.

**Mind the direction.** The rows are newest run first: element 0 is the most recent run in the
window, so the run a failure *started* at is the **last** row of the leading failed block, not the
first. Read front-to-back as run 1 onwards and the regression above reads as four failures at the
start of the window that have passed since — a fixed flake, the exact inversion of the truth, and
nothing errors to signal it. The 200-row cap drops the **oldest** rows for the same reason, so a
truncated sequence is still the recent runs. Read the run off each row's `commit_sha`/`test_run_id`
and never off its index: a run that recorded nothing under the description contributes no row, and a
description carried by two examples in one run contributes two, so `rows` is not one entry per run
and its length is not the window's `run_count`.

Figures are `null` where CI did not report them. A `null` means *not measured*; it is never a zero,
because a zero would read as a measurement that was taken.

## How it works

```
agent  ⇄  specguard-mcp  ⇄  SpecGuard         (HTTP, the same API the dashboard uses)
        (stdio/MCP)      ⇄  specguard-lint    (subprocess, in your project)
```

The bridge is a **thin client**: it shells out and it calls the API, and it re-implements neither.
It carries no knowledge of the OpenTestIntent schema, holds no copy of the linter's rules, and
reshapes no response — both tools return the shape of the capability they wrap, so a field added
upstream reaches the agent without a release here.

Authorization and project scoping are enforced by SpecGuard, never by this bridge, using the same
`sgk_…` keys CI uses to ingest runs. The bridge adds no credentials of its own and stores nothing.

No argument ever reaches a shell: subprocesses are spawned with an argument list, so a path from a
model is a path that does not exist rather than a command.

## Adding a tool

The toolset fills in as more of SpecGuard lands. Adding one is two mechanical edits:

1. a new file under `src/tools/` that default-exports a `ToolDefinition`;
2. one entry appended to the array in `src/tools/index.ts`.

There is no third — no third *wiring* edit, at least: every tool also earns a `### ` section with an
argument table above, and every argument earns a row in that table, since this README ships as the
package's published documentation, and `test/readme.test.ts` derives that obligation from the
registry so a missing section or an undocumented parameter fails the suite. `src/server.ts` iterates
that array and contains no per-tool code — no `switch`, no hard-coded name — and everything a tool
touches the world with (config, subprocesses, `fetch`) is injected, so a new tool is testable
without a live deployment for free. The property tests in `test/tools/registry.test.ts` run over
whatever the registry holds, so a tool added later is checked by tests written today.

**Only wrap capabilities that exist.** A tool in `tools/list` is a promise an agent acts on; one that
discovers cleanly and fails on use is worse than one that is absent, because the agent has already
committed to a plan by the time it finds out. `/check-intent` and duplicate clustering are therefore
not here, and should arrive when their backing data and engine do.

Transport is chosen in `bin/specguard-mcp.ts` and nowhere else — stdio today, so an HTTP/SSE
entrypoint is a sibling of that file rather than a change to the server.

## Development

```bash
npm run build      # compile to dist/
npm test           # typecheck, then run the suite
npm run typecheck  # types only
```

## Related repositories

- [`specguard`](https://github.com/yatfa-ai/specguard) — the platform: ingest API + Hotwire dashboard
- [`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec) — Ruby client (RSpec formatter + `@intent` linter)
- [`open-test-intent`](https://github.com/yatfa-ai/open-test-intent) — the annotation protocol SpecGuard consumes

## License

ISC

---

<p align="center">
  <a href="https://yatfa.com">
    <img src="assets/built-with-yatfa.png" alt="Built with yatfa — a team of AI agents that plans, builds &amp; ships software." width="100%">
  </a>
</p>
