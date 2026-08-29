# specguard-mcp

> The MCP bridge to [SpecGuard](https://github.com/yatfa-ai/specguard) — gives an AI agent the suite
> intelligence behind a very large test suite as tools.

`specguard-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects
an MCP-capable agent (Claude Code, Claude Desktop, …) to SpecGuard, so the agent can ask what a
suite covers, what it costs to run and where the gaps are — without a line of HTTP or auth code in
its prompt.

SpecGuard is built [primarily for AI coding agents](https://github.com/yatfa-ai/specguard); this
bridge is how an agent reaches it without scraping a web UI.

> **Status: bootstrap.** A small set of tools ships today, each wrapping a capability that already
> exists — see [The tools](#the-tools) for what is in it. The toolset **grows gradually** — see
> [Adding a tool](#adding-a-tool). It is not published to npm yet; install from a checkout.

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
| `SPECGUARD_ENDPOINT` | `get_repository_overview`, `list_repositories`, `add_repository`, `registrable_repositories` | — | your SpecGuard instance's root URL, **including the scheme** — e.g. `https://specguard.example.com`, or `http://localhost:3000`. A value with no scheme is refused by name (`SPECGUARD_ENDPOINT is not a usable URL: "sg.example.com"`) rather than surfacing later as an opaque failure. `SPECGUARD_URL` is accepted as an alias, and is the name every message uses when it is the one you set. A blank value counts as unset, so leaving `SPECGUARD_ENDPOINT` empty in a templated config falls through to `SPECGUARD_URL` instead of suppressing it |
| `SPECGUARD_API_KEY` | `get_repository_overview` | — | an agent/CI API key (`sgk_…`) issued by that deployment |
| `SPECGUARD_USER_API_KEY` | `list_repositories`, `add_repository`, `registrable_repositories`, `remove_repository`, `create_repository_api_key`, `revoke_repository_api_key`, `list_repository_members`, `add_repository_member`, `update_repository_member_permissions`, `remove_repository_member` | — | a **user** API key (`sgu_…`), minted from that deployment's account page. A different credential from the one above, not a second place to put the same value: SpecGuard decides which of them a request may use from the token's prefix, before it reads anything, and answers `401` for the other one. Set whichever your tools need — both, if you use both |
| `SPECGUARD_LINT_COMMAND` | `lint_intent_annotations` | `specguard-lint` | the command that runs the linter. Most Ruby projects need `bundle exec specguard-lint` |
| `SPECGUARD_TIMEOUT_MS` | HTTP tools | `30000` | how long a call to SpecGuard may take |

`SPECGUARD_ENDPOINT` and `SPECGUARD_API_KEY` are the same variables
[`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec) uses to ship a run, so a repository
that already posts telemetry to SpecGuard already has them. `SPECGUARD_USER_API_KEY` is **not** one
of them — the gem has no notion of a user key — so that one is minted and set here for the first
time.

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
        "SPECGUARD_USER_API_KEY": "sgu_…",
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
| `commit_sha` | anchor the answer on ONE named run instead of the repository's newest one — every run-grain block moves with it, `history` does not |
| `unannotated_examples` | `true` to list the individual tests carrying no `@intent` — the examples behind the annotated ratio, each labelled with what SpecGuard reads of it — and, in the same answer, which areas carry the most of them |

`branch` narrows `history` only — `latest_run` always names the repository's newest run, which on a
busy repo may be on another branch. That is a property of the endpoint, not of this bridge — and
`commit_sha` is the remedy: it names WHICH RUN to describe, where `branch` asks about a series. Every
run-grain block re-anchors together (`latest_run` and its rollups, the four run-grain drill-ins —
`spec_directory_files`, `spec_file_examples`, `repeated_description_examples`, `unannotated_examples`
— `shards`, both growth windows, `previous_test_run`); `history` does not, so the
`history[0] == latest_run` identity holds
on a default call and is **not** expected to hold under an explicit ask. Nor does `unstable_test_runs`,
which is read over the branch window rather than off the anchored run. (`unannotated_directories`,
below, re-anchors too and is *not* a fifth drill-in: this roster carries one representative key per
drill-in **parameter**, not one entry per response key — `spec_directory` opens three blocks and only
`spec_directory_files` is listed, with `directory_run_file_growth` and `directory_runtime_file_growth`
absent for the same reason. `unannotated_directories` is a second block of an existing parameter's ask
and adds no parameter, so it is covered above by *`latest_run` and its rollups* and the roster stays at
four.) A sha with no run — a stale
bookmark, a pruned run, a commit whose CI never reported — does not error: the endpoint
falls back to the newest run and says so, so read `run_anchor.resolved` rather than trusting that a
successful response is about the commit you named.

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

`annotated_ratio` is the product's adoption metric and it was the one population on this endpoint
you could not walk down: the dashboard printed *"SpecGuard cannot see the other N tests"* and could
not name one of them either, so an agent told to raise annotation coverage learned how far it had to
go and not a single test to annotate. `unannotated_examples` is that rung.

**Unannotated is not the same as unreadable, and the difference is on every response.** A test
called `Invoice#total sums the line items` has an entity, an action and a behavior in its own
description, so SpecGuard reads it whether or not anybody annotated it.
`latest_run.intent_readings` splits the run's examples into `authored` (an `@intent` a human wrote),
`derived` (read from the description) and `unreadable` (neither), with the `recorded` population
they were counted from — no flag to pass. **`unreadable` is the only figure on this endpoint that
means tests SpecGuard can say nothing about.** `total_specs - annotated_specs` is annotation debt,
which on a suite that has never been annotated is the whole suite and almost all of it readable;
never render that subtraction as blindness. A derived reading is genuinely weaker than an authored
one — no preconditions, a behavior written for a test runner's output rather than declared, and a
layer inferred from the directory — so report it as inferred and never as equivalent. And
`authored` never replaces `annotated_ratio`: "how much of this suite has a human-written intent" is
still that figure, off the run's own counters. It is the one argument
here that is a **flag rather than a name** — pass `true`, not a value — because it opens a
*population* rather than a pick: `total_specs` minus `annotated_specs` is a subtraction, and a
subtraction has no line to name. Which population is still yours to choose: sent alone the flag
opens the whole run, and sent **together with** `spec_file` or `spec_directory` it narrows to that
file, that area, or the AND of the two — those two keep opening their own blocks as well, so
narrowing this one is additional rather than instead. `latest_run.unannotated_examples` opens with
up to 100 of the unannotated examples **of whatever you asked for** (`name`, `file_path`,
`line_number`, `spec_file_path`, `reading` and `derived_intent` each — six fields, and not the
per-example drill-ins' six: no `duration_seconds` and no `outcome`), plus that
same population's own `recorded_count`, `derived_count` and `unreadable_count`, the `limit` the row
list was cut at, and
`spec_file`/`spec_directory` **echoed back** as the server read them — `null` for each one you did
not send. Read the echo before the count: the **worklist's** `recorded_count` — and only that one,
because the map below deliberately does not narrow — is the figure you would reconcile against
`total_specs - annotated_specs`, and it counts the *narrowed* population whenever either echo is
non-null, so that reconciliation is expected to hold only when both are `null`. Do not re-derive
that count from `rows` either way: un-narrowed, this population is routinely the entire run — a
repository that has just installed the gem has every test in it — so the cap fires as the normal
case here rather than the exotic one, and a narrowed ask is cut at the same 100.

That one ask opens **two** blocks, each in its own grain: `latest_run.unannotated_examples` for
*which tests* to go and annotate, and `latest_run.unannotated_directories` for *where the debt is* —
the run's annotation debt rolled up by code area, which is what you pick the next `spec_directory`
narrowing **from**. Both come from the one flag; there is no second argument to send and no new
value. Each worklist row carries `reading` — `"derived"` or `"unreadable"` — and `derived_intent`,
the `entity`/`action`/`behavior` SpecGuard got from the description or `null`; the **unreadable rows
come first**, so the 100-row cap cannot hide them. The map's rows carry `path`,
`unannotated_count`, the `recorded_count` that area was counted against, and the same three-way
split — `authored_count`, `derived_count` and `unreadable_count`, which sum to `recorded_count`
while the last two sum to `unannotated_count` (the operands, never a fraction), plus
`directory_count` — **every** area the run
touched, not every area with debt, and not `rows.size` — and its **own** `limit`, which is **10 and
not the worklist's 100**. Two caps under one ask, and the difference is the kind of list: 100 caps a
*worklist* to work through, 10 caps a *ranking* to pick from. The orders differ for the same reason —
the worklist is file-navigable within each reading, the map is ranked `unreadable_count` descending,
then `unannotated_count` descending, with `path` as a tiebreak only — the areas SpecGuard cannot
read lead, because a ten-row ranking led by debt on an unannotated suite is a ranking by area size
and the dark corners never surface. A fully-annotated area is a real **row** with `unannotated_count: 0`, never an
omission; those rows sort last *collectively*, so on a run with more areas than the cap they are cut
and never seen, but on a run inside the cap they *are* listed and listed is correct. So `rows.size` is
not a count of areas *with* debt — read each row's `unannotated_count`. Both blocks are at run grain,
so both move with `commit_sha`.

**The two blocks disagree in two places, on purpose — do not reconcile them by arithmetic.**
*Scope:* `spec_file`/`spec_directory` narrow the **worklist** and its `recorded_count`, and the
**map stays whole-run** under both. So under a narrowing `unannotated_examples.recorded_count` is
*not* the sum of `unannotated_directories.rows[].unannotated_count`, and neither figure is wrong:
one counts the area or file you named, the other ranks the whole run. The map is whole-run by design
because it is the thing you choose a narrowing *from* — narrowed to the area you had already picked
it would answer nothing. The sum is short of the run's total whenever `directory_count > rows.size`
besides, narrowing or not. *Null versus empty:* on a run that recorded no per-example rows at all,
with the flag sent, `unannotated_examples` is a **present** block with `rows: []` and
`recorded_count: 0` while `unannotated_directories` is **`null`**. That is a signal rather than an
inconsistency — `recorded_count: 0` on the worklist means *both* "fully annotated" and "recorded
nothing", and the map is how you tell them apart: a present map beside that zero means the zero is
the success state, a `null` map means the run recorded nothing and the zero is an absence of data.

`false` means the same as omitting it and sends nothing at all. That matters more here than
elsewhere: the server reads only whether the parameter was **named**, so `?unannotated_examples=false`
on the wire would open the block for a caller who asked for it not to be — declining is not sending,
which is how every other argument here is declined too. Omit the flag and **both** keys are `null`,
meaning you did not ask. A **fully-annotated run is not an error and not a `null`**: the worklist
answers 200 with `rows: []` and `recorded_count: 0`, because that is the state the metric exists to
reach — walk a repository to completion and the block goes empty rather than vanishing. A narrowing
that matched nothing reads the same way and is never a 404: an unknown or renamed path, an already
fully-annotated file, and a contradictory file-and-area pair all answer `rows: []` with both
narrowings echoed, which is an empty intersection rather than a dropped parameter.

**Two blocks come back on every response, and they take no argument at all.** They answer what every
figure above silently depends on — is SpecGuard still being fed? `delivery_health` is why the data
may be **stale**: `refusing` compares stamps rather than reading a live wire — it is true when the
newest refusal is newer than the newest *accepted* run, and true when nothing has ever been
accepted, so a repository refused once and quiet since still answers `true`. Read it with
`last_rejection_at` and judge recency yourself. Each retained rejection carries the endpoint's own
reasons and, where the client reported one, the client
version that sent it. A `latest_run` from days ago beside a live rejection stream is a suite
SpecGuard *stopped accepting*, not a suite nobody ran. `credential_health` covers the break that one
structurally **cannot** see: a rejected key resolves no repository and writes no rejection row, so an
authentication-broken pipeline is invisible to every rejection figure — it names any key that was
**rotated** and has not authenticated since, a secret some pipeline has not picked up.
A quiet answer is a **finding, not a gap**: `refusing: false` is "nothing was refused" and
`rotated_and_unused: false` is "no key is stranded", and neither means "SpecGuard does not track
that". Do **not** read `api_key.last_used_at` as evidence anything was *accepted* — it is stamped on
the way in, before the payload is looked at, so a repository having every run thrown away still
reports it seconds ago; the endpoint says so itself in `acceptance_reported_by` and
`rotation_reported_by`, which name these two blocks. Where a bound sits beside a list, the list is
a **page and not the set**: `limit` next to `rows`, or on that list's `*_window` block, which is
also where the *order* the cut was made in is named when the list has one. What announces the cut
varies too — `truncated`, `bounded`, `returned` short of `limit`, or a `recorded_count` larger than
the rows served — so read the bound beside the list in front of you and never take a full-looking
ranking for the whole set. Where **no** bound sits beside a list, it is everything there was:
`credential_health.keys` and both `latest_run.shards` lists are complete by construction, which is
a finding and not a disclosure someone forgot.

Figures are `null` where CI did not report them. A `null` means *not measured*; it is never a zero,
because a zero would read as a measurement that was taken.

### `list_repositories`

Lists the SpecGuard repositories the person behind `SPECGUARD_USER_API_KEY` may open — *what can I
ask about*, which is the one question no other tool here can answer. `get_repository_overview` takes
no repository because its `sgk_…` key **is** the repository, so without this an agent can only report
on a repository somebody already named for it.

**This tool takes no arguments** — and not as an omission. The credential is the whole of the scope:
the endpoint takes no parameters, and which repositories are in the answer is decided by SpecGuard
from the person the key speaks for (owned, plus shared with them through a membership). A repository
they neither own nor were given access to never enters the response, so it cannot be filtered *in*
from this side either.

The body comes back as SpecGuard serves it — `{"repositories": […]}`, each entry carrying `id`,
`full_name`, `name`, `registered_at` and `role`, ordered by `full_name` ascending. The first four are
deliberately the same four fields, under the same names, that `get_repository_overview` serves in its
own `repository` block, so a client that reads one reads the other. `role` is `owner` or `member`:
the list mixes repositories this person owns with repositories somebody shared with them, and nothing
else tells them apart — read it before assuming a repository is one you may administer. An empty list
means no access, not an error.

**It reads a different key from `get_repository_overview`.** `SPECGUARD_USER_API_KEY` (`sgu_…`), not
`SPECGUARD_API_KEY` (`sgk_…`). SpecGuard refuses each credential in the other's place — the prefix
decides which table is consulted before any of them is read — so the two are not interchangeable and
setting one does not stand in for the other. Every message this tool produces names the variable
*it* reads, so a `401` here never sends you to check the key `get_repository_overview` uses.

Registering a repository is `add_repository`, below — it reads the same `sgu_…` key and takes the
`full_name` this tool reports. Removal and the key lifecycle (`remove_repository`,
`create_repository_api_key`, `revoke_repository_api_key`) are below too, on the same key; a tool
here is a promise the agent will act on, so each waits for the capability rather than the other way
round.

### `add_repository`

Registers a GitHub repository with SpecGuard for the person behind `SPECGUARD_USER_API_KEY`, and
returns the repository together with its **first CI API key** — the `sgk_…` key that repository's CI
will use to ingest runs, minted in the same call so a fresh registration is usable without a second
trip through the browser.

| argument | |
| --- | --- |
| `full_name` | the repository to register, as `org/repo` (for example `acme/billing`) — the same handle `list_repositories` reports. Not a URL, not a bare repository name |

The body comes back as SpecGuard serves it: a `repository` block (`id`, `full_name`, `name`,
`registered_at` — deliberately the same four fields `get_repository_overview` serves in its own
`repository` block) and an `api_key` block (`name`, `token`, `hint`, `created_at`).

> ⚠️ **`api_key.token` is shown once and never again.** Nothing stores it and no endpoint can
> re-serve it. Capture it from this response — an agent should hand it straight to the person it is
> working for. A key that is lost is replaced from SpecGuard's API-keys page in a browser, not from
> here.

> ⚠️ **This tool is not idempotent, and it writes.** If the call exceeds `SPECGUARD_TIMEOUT_MS` the
> bridge gives up, but the registration may still have succeeded on the server — taking its one-time
> token into a response nobody received. The retry is then refused with `has already been taken`,
> which is the honest answer rather than a bug. Do not retry a timeout blindly; check
> `list_repositories`, and recover the key in the browser.

**It needs a current record of your GitHub permissions, and only a browser creates one.** SpecGuard
decides whether you may register a repository from a stored grant, and fails closed when that grant
is missing or stale — which is every person who has not signed in and connected GitHub recently. That
refusal arrives as SpecGuard's own sentence, verbatim, naming the fix: *sign in to SpecGuard in a
browser and reconnect GitHub, then try again*. No argument to this tool substitutes for it. The same
path carries the other refusals — a repository the SpecGuard GitHub App is not installed on, one you
do not administer, one already registered.

**The `org/repo` format is not re-checked here.** This bridge verifies only that you passed a
non-blank string; SpecGuard validates the name and refuses an unusable one in its own words. A second
format rule on this side would be free to drift from the one that actually decides, and would surface
as this bridge rejecting a name the platform would have accepted.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and a
different one from the `sgk_…` key `get_repository_overview` uses.

### `registrable_repositories`

Lists the GitHub repositories the person behind `SPECGUARD_USER_API_KEY` **could** register with
SpecGuard — the set the registration gate would consult, read out loud in advance, so an agent can
pick a `full_name` for `add_repository` from a real answer rather than by guessing. `list_repositories`
reports what *is* registered; this reports what could be, and the two answer different questions.

The body comes back as SpecGuard serves it: `{"repositories": […]}` with each entry carrying
`full_name` and `registered`, ordered by `full_name` ascending, plus a `grant` block (`captured_at`,
`expires_at`, `stale`) describing the stored record of this person's GitHub permissions.

**`registered` is asked globally, not just of your own repositories.** An entry marked
`registered: true` was registered by *somebody* — possibly someone else — and a POST naming it will
be refused with `has already been taken`. That is exactly why entries are *marked* rather than
excluded: a reading scoped to what you can open would send you at a name nobody can register.

**A name appearing here is not a promise the write will succeed.** This is the set the gate would
consult at the moment of the read; the repository may be registered by someone else between this
call and your POST.

**A missing or stale grant is not an error — it is the modal first answer.** SpecGuard fails closed
when it has no current record of your GitHub permissions, which is every person who has not opened
SpecGuard in a browser recently. The call then answers `403` with SpecGuard's own sentence naming
the fix: *sign in to SpecGuard in a browser and reconnect GitHub, then try again*. On that refusal
the body still carries `grant`, and it distinguishes the two cases: `grant: null` means there never
was one (first-time setup), a populated grant with `stale: true` means an existing connection lapsed
— same remedy, very different urgency. Read it before telling the person what to do.

**This tool takes no arguments** — the credential is the whole of the scope. The endpoint takes no
parameters; which repositories are in the answer is decided by SpecGuard from the person the key
speaks for.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `near_duplicate_clusters`

Runs SpecGuard's near-duplicate census over a repository's tests — which tests *read alike* (same
body text, whatever file they sit in), clustered by similarity. Answers the refactoring question
the overview's per-run rankings cannot: where the same test is written twice, before you delete or
merge anything.

**This is the expensive read in this toolset.** The census is linear but measured in seconds —
seven queries at every size, tens of seconds extrapolated at the 20,000-test design point — which
is why the platform serves it only to a client that asks (`?near_duplicates=`, shipped by SPGD-703)
and answers `near_duplicates: null` on the plain overview. Calling this tool **is** the ask;
`get_repository_overview` never sends it, so an agent reading the overview cannot pay the census by
accident.

**This tool takes no arguments** — nothing about the census is choosable. The clusters are the
repository's, computed over every run; one call returns them all. (The server reads only that the
`near_duplicates` key is *present* — `=false` would open it too — so there is no value for an
argument to carry.)

Read the response with its own rules in mind:

- `similarity_floor` and `similarity_basis` sit **first** in the block and qualify every figure
  below them — a cluster count without what "similar" meant is a count you cannot act on.
- `member_count` (texts in the repository, across every run) and `example_count` (examples in the
  one run `weighed_run_id` names) are **different grains**: a three-example table-driven loop is
  one member and three examples. Never fold them.
- `truncated: true` means the `clusters` list was cut at the cap while the counts above it
  (`cluster_count`, `identity_count`, `clustered_*`) describe the whole census.
- `unobserved_members: true` on a cluster says a member identity the weighed run did not observe
  (deleted, renamed, deselected) is still listed — do not reconcile the member list against that
  run's examples.
- `similarity_range` is `[strongest, weakest]`: membership is transitive, similarity is not.
- `total_seconds` is `null` where nothing was timed — never a zero that would read as free.
- `clusters: []` with a real `identity_count` is the **success** state (nothing reads alike); the
  three silences — nothing ingested, nothing embedded, nothing alike — are kept distinguishable by
  `recorded_count` / `identity_count` / the list itself.

Same credential and endpoint as `get_repository_overview` (`sgk_…` repository key on
`GET /api/v1/repository`); the response is that endpoint's full body with the `near_duplicates`
block opened, passed through unmodified.

### `remove_repository`

Removes a repository from SpecGuard — and with it **every key, run and intent on it**. This is the
destructive gesture in this toolset: irreversible, no undo, and a `204` means the repository and its
history are gone short of re-registering from scratch. Confirm with the user before calling.

| argument | |
| --- | --- |
| `repository_id` | the repository to remove — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |

Authorization is the `repo.delete` capability at **either surface** — an owner, or a member granted
`repo.delete`, may remove the repository. A member without it is refused `403` with SpecGuard's own
sentence, verbatim. The repository's CI keys stop authenticating the moment it succeeds.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `create_repository_api_key`

Mints a new CI API key (`sgk_…`) for a SpecGuard repository and returns it alongside the
repository's existing keys. Minting does not disturb existing keys — each key on a repository
authenticates independently until revoked.

| argument | |
| --- | --- |
| `repository_id` | the repository to mint the key for — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |
| `name` | an optional label for the key; omit it to let SpecGuard use its default name |

The body comes back as SpecGuard serves it: an `api_key` block (`name`, `token`, `hint`,
`created_at`) — the same shape `add_repository` serves.

> ⚠️ **`api_key.token` is shown once and never again.** Nothing stores it and no endpoint can
> re-serve it. Hand it to the person you are working for in your reply. If it is dropped, the
> recovery is minting another key with this same tool — the platform has no regenerate — then
> revoking the orphaned one with `revoke_repository_api_key`.

Authorization is the `keys_manage` capability; a member without it is refused `403` with SpecGuard's
own sentence, verbatim.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `revoke_repository_api_key`

Revokes one CI API key on a SpecGuard repository. The key stops authenticating immediately; every
**other** key on the repository keeps working, so CI keeps ingesting if it holds a surviving key.

| argument | |
| --- | --- |
| `repository_id` | the repository the key belongs to — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |
| `key_id` | the id of the key to revoke, as served in the `api_key` block of `add_repository` or `create_repository_api_key` |

The `key_id` is scoped to `repository_id`: a key id belonging to a different repository is refused
`404`, never a cross-repository delete. Authorization is the `keys_manage` capability; a member
without it is refused `403` with SpecGuard's own sentence, verbatim.

**Key rotation is mint-then-revoke, in that order.** The platform has no regenerate, so mint a
replacement with `create_repository_api_key` and deploy it BEFORE revoking the old one — revoke
first and the repository's CI is locked out until a human mints a new key in a browser. A `204`
means the key is revoked.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `list_repository_members`

Lists who has access to a SpecGuard repository: one row per member with their `handle`,
`permissions`, `granted_by` (who last set them) and `created_at`, ordered by handle.

| argument | |
| --- | --- |
| `repository_id` | the repository — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |

The list answers **memberships only** and never reports how many CI keys a member has minted
(`keys_minted`) — that is a separate `keys.manage` disclosure this endpoint deliberately withholds;
the API-keys tools are the surface for it. The response carries **no membership id**, by design.

Authorization is the `members.manage` capability: a caller who is not a member is refused `404`
(the repository's existence stays hidden), and a member without `members.manage` is refused `403`
with SpecGuard's own sentence, verbatim.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `add_repository_member`

Grants a person access to a SpecGuard repository by their GitHub handle, with an optional list of
permissions.

| argument | |
| --- | --- |
| `repository_id` | the repository to grant access to — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |
| `handle` | the person's GitHub **login** — `octocat`, not a profile URL and not a display name; SpecGuard refuses both with its own sentence |
| `permissions` | an optional list of permission strings (`view`, `keys.manage`, `members.manage`, `repo.delete`); omit it to grant access with no additional permissions |

Each resolution failure — nobody has signed in as that handle yet, the account is archived, the
handle is ambiguous, the handle is not a login — arrives as a **distinguishable** 400 message
naming the exact next move. The grantor recorded on the membership is always the person behind
`SPECGUARD_USER_API_KEY`; no argument can name a different one.

On success (`201`) the response carries a `member` block (`handle`, `permissions`, `granted_by`,
`created_at`) — and **no membership id**, by design. Authorization is the `members.manage`
capability; a member without it is refused `403` with SpecGuard's own sentence, verbatim.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `update_repository_member_permissions`

Replaces one member's permission set on a SpecGuard repository.

| argument | |
| --- | --- |
| `repository_id` | the repository the membership belongs to — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |
| `member_id` | the id of the **membership** row to edit — not a user id, not the handle. Scoped to `repository_id`: a foreign membership id is refused `404` |
| `permissions` | the member's **complete new** permission set (`view`, `keys.manage`, `members.manage`, `repo.delete`) — it replaces what they hold today, it is not merged |

**`permissions` replaces the whole set** — name every permission the member should end with.
Values are validated by SpecGuard; an unknown value is refused with its own sentence, verbatim.

**Known limitation:** no API endpoint serves the membership id — the member list and the
add-member response both omit it by design — so the id must be obtained from the platform (today
via the repository's web members page). There is no name-based lookup. Authorization is the
`members.manage` capability; a member without it is refused `403` with SpecGuard's own sentence,
verbatim.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

### `remove_repository_member`

Revokes one person's access to a SpecGuard repository by removing their membership. A `204` means
it is revoked.

| argument | |
| --- | --- |
| `repository_id` | the repository the membership belongs to — its numeric `id`, as `add_repository` returns and `list_repositories` reports, not the `org/repo` handle |
| `member_id` | the id of the **membership** row to revoke — not a user id, not the handle. Scoped to `repository_id`: a foreign membership id is refused `404` |

**Revoking does NOT revoke that member's minted CI keys.** Any `sgk_…` keys they created on the
repository keep authenticating by design; the lever for those is the API-keys surface
(`revoke_repository_api_key`), not this one. Self-revocation is permitted — after it, the caller's
next request to the member routes answers `404`, not `403`. The repository owner's membership
cannot be removed at all. The same known limitation as the edit tool applies to `member_id`: no
endpoint serves it, so it comes from the platform's web members page today. Authorization is the
`members.manage` capability; a member without it is refused `403` with SpecGuard's own sentence,
verbatim.

It reads `SPECGUARD_USER_API_KEY` (`sgu_…`), the same credential as `list_repositories` and
`add_repository` and a different one from the `sgk_…` key `get_repository_overview` uses.

## How it works

```
agent  ⇄  specguard-mcp  ⇄  SpecGuard         (HTTP, the same API the dashboard uses)
        (stdio/MCP)      ⇄  specguard-lint    (subprocess, in your project)
```

The bridge is a **thin client**: it shells out and it calls the API, and it re-implements neither.
It carries no knowledge of the OpenTestIntent schema, holds no copy of the linter's rules, and
reshapes no response — every tool returns the shape of the capability it wraps, so a field added
upstream reaches the agent without a release here.

Authorization and project scoping are enforced by SpecGuard, never by this bridge, using keys you
issue there — the same `sgk_…` keys CI uses to ingest runs, and, for the tools that answer to a
person rather than to a repository, an `sgu_…` user key. Which of the two a request may carry is
SpecGuard's decision and it is taken from the token's prefix, before any credential is looked up, so
the bridge cannot widen either one's reach: it forwards the key the tool's own variable holds and
reports what came back. It adds no credentials of its own and stores nothing.

No argument ever reaches a shell: subprocesses are spawned with an argument list, so a path from a
model is a path that does not exist rather than a command.

## Adding a tool

The toolset fills in as more of SpecGuard lands. Adding one is two mechanical edits:

1. a new file under `src/tools/` that default-exports a `ToolDefinition`;
2. one entry appended to the array in `src/tools/index.ts`.

There is no third — no third *wiring* edit, at least: every tool also earns a `### ` section above,
and every argument earns a row in that section's table, since this README ships as the package's
published documentation, and `test/readme.test.ts` derives that obligation from the registry so a
missing section or an undocumented parameter fails the suite. A tool that genuinely takes no
arguments (`list_repositories` is the first) still earns the section, and is named in that file's
`ARGUMENT_LESS_TOOLS` — a deliberate line to add, rather than a floor relaxed for everyone.
`src/server.ts` iterates that array and contains no per-tool code — no `switch`, no hard-coded name — and everything a tool
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
