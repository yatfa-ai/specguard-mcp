import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CommandError } from "../../src/errors.js";
import lintIntentAnnotations from "../../src/tools/lint-intent-annotations.js";
import { rejects, stubCommand, toolContext } from "../support/stubs.js";

/** A real directory, because `project_dir` is now checked against the real filesystem. */
const REAL_DIR = mkdtempSync(join(tmpdir(), "specguard-mcp-test-"));

/** A minimal document in the shape `specguard-lint --json` emits (SPGD-305). */
function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "open-test-intent.v1.json",
    mode: "source",
    ok: true,
    summary: { files: 1, annotations: 2, failed: 0 },
    findings: [],
    ...overrides,
  });
}

const FAILING = report({
  ok: false,
  summary: { files: 1, annotations: 2, failed: 1 },
  findings: [
    {
      file: "spec/models/order_spec.rb",
      line: 24,
      ok: false,
      kind: "schema",
      errors: ["<root>: additional property 'entiity' is not allowed"],
    },
  ],
});

describe("lint_intent_annotations — the command it builds", () => {
  it("always passes --json, because the structured document is the point", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run({}, toolContext({ runCommand: command.runCommand }));

    assert.deepEqual(command.calls[0]?.argv, ["specguard-lint", "--json"]);
  });

  it("uses SPECGUARD_LINT_COMMAND, so a bundled project can be linted", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run(
      {},
      toolContext({ runCommand: command.runCommand, env: { SPECGUARD_LINT_COMMAND: "bundle exec specguard-lint" } }),
    );

    assert.deepEqual(command.calls[0]?.argv, ["bundle", "exec", "specguard-lint", "--json"]);
  });

  it("runs in project_dir when one is given", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run({ project_dir: REAL_DIR }, toolContext({ runCommand: command.runCommand }));

    assert.equal(command.calls[0]?.options?.cwd, REAL_DIR);
  });

  it("trims project_dir, so a concatenated path is not a directory that cannot exist", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run(
      { project_dir: `  ${REAL_DIR} ` },
      toolContext({ runCommand: command.runCommand }),
    );

    assert.equal(command.calls[0]?.options?.cwd, REAL_DIR);
  });

  it("passes paths positionally", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run(
      { paths: ["spec/a_spec.rb", "spec/b_spec.rb"] },
      toolContext({ runCommand: command.runCommand }),
    );

    assert.deepEqual(command.calls[0]?.argv, ["specguard-lint", "--json", "spec/a_spec.rb", "spec/b_spec.rb"]);
  });

  it("sends --changed bare, and --changed=BASE when a base is given", async () => {
    const bare = stubCommand({ stdout: report() });
    await lintIntentAnnotations.run({ changed: true }, toolContext({ runCommand: bare.runCommand }));
    assert.deepEqual(bare.calls[0]?.argv, ["specguard-lint", "--json", "--changed"]);

    const based = stubCommand({ stdout: report() });
    await lintIntentAnnotations.run({ changed: true, base: "origin/main" }, toolContext({ runCommand: based.runCommand }));
    assert.deepEqual(based.calls[0]?.argv, ["specguard-lint", "--json", "--changed=origin/main"]);
  });

  it("ignores `base` without `changed`, exactly as the flag does", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run({ base: "origin/main" }, toolContext({ runCommand: command.runCommand }));

    assert.deepEqual(command.calls[0]?.argv, ["specguard-lint", "--json"]);
  });

  it("forwards --changed WITH paths rather than pre-empting the linter's own misuse rule", async () => {
    // The linter owns this contract and exits 2 saying so. Re-implementing the
    // rule here would put a second copy of its argument grammar in another
    // language, free to drift.
    const command = stubCommand({ code: 2, stderr: "specguard-lint: error: --changed cannot be combined with explicit files" });

    await rejects(
      lintIntentAnnotations.run({ changed: true, paths: ["spec/a_spec.rb"] }, toolContext({ runCommand: command.runCommand })),
      /--changed cannot be combined/,
    );

    assert.deepEqual(command.calls[0]?.argv, ["specguard-lint", "--json", "--changed", "spec/a_spec.rb"]);
  });
});

describe("lint_intent_annotations — the exit-code contract", () => {
  it("exit 0 is a clean result", async () => {
    const result = await lintIntentAnnotations.run(
      {},
      toolContext({ runCommand: stubCommand({ code: 0, stdout: report() }).runCommand }),
    );

    assert.equal(result.structured?.["exit_code"], 0);
    assert.equal(result.structured?.["ok"], true);
  });

  it("exit 1 is a SUCCESSFUL call carrying findings — never a tool error", async () => {
    // An agent told "the tool failed" retries the tool; an agent handed findings
    // fixes the annotation. This mapping is the whole difference.
    const result = await lintIntentAnnotations.run(
      {},
      toolContext({ runCommand: stubCommand({ code: 1, stdout: FAILING }).runCommand }),
    );

    assert.equal(result.structured?.["exit_code"], 1);
    assert.equal(result.structured?.["ok"], false);

    const parsed = result.structured?.["report"] as { findings: unknown[] };
    assert.equal(parsed.findings.length, 1);
    assert.match(result.text, /entiity/);
  });

  it("exit 2 is the only tool error, and carries the linter's stderr prose", async () => {
    // The gem deliberately emits NO document on exit 2, so stderr is the entire
    // diagnosis.
    const error = await rejects(
      lintIntentAnnotations.run(
        {},
        toolContext({ runCommand: stubCommand({ code: 2, stdout: "", stderr: "error: could not load schema" }).runCommand }),
      ),
      /could not load schema/,
    );

    // The type is what carries that prose to the agent intact. As a plain
    // `Error` the same words reach it wrapped in "this is a bug in the bridge,
    // not in your project or configuration" — which is a claim about the wrong
    // codebase, and the linter's own account of what it could not load is then
    // read as noise from a broken server.
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("treats a signal death as no-verdict rather than as a clean run", async () => {
    await rejects(
      lintIntentAnnotations.run(
        {},
        toolContext({ runCommand: stubCommand({ code: null, signal: "SIGKILL" }).runCommand }),
      ),
      /could not check anything/,
    );
  });

  it("passes the stderr provenance line through, since the document omits it", async () => {
    // SPGD-247 keeps "which validator produced these verdicts" in exactly one
    // place — stderr — so dropping it here would make it unanswerable.
    const result = await lintIntentAnnotations.run(
      {},
      toolContext({
        runCommand: stubCommand({
          code: 0,
          stdout: report(),
          stderr: "specguard-lint: validated in Ruby (SPECGUARD_VALIDATE_INTENT is unset)",
        }).runCommand,
      }),
    );

    assert.match(String(result.structured?.["linter_stderr"]), /validated in Ruby/);
    assert.match(result.text, /validated in Ruby/);
  });

  it("echoes the document through untouched, so a new gem field needs no release here", async () => {
    const withNewField = report({ future_key: { anything: [1, 2, 3] } });

    const result = await lintIntentAnnotations.run(
      {},
      toolContext({ runCommand: stubCommand({ stdout: withNewField }).runCommand }),
    );

    assert.deepEqual(result.structured?.["report"], JSON.parse(withNewField));
  });
});

describe("lint_intent_annotations — bad output and bad arguments", () => {
  it("refuses a verdict with no document rather than reporting a clean run", async () => {
    await rejects(
      lintIntentAnnotations.run({}, toolContext({ runCommand: stubCommand({ code: 0, stdout: "  " }).runCommand })),
      /wrote no JSON document/,
    );
  });

  // The realistic shape of that failure: SPECGUARD_LINT_COMMAND wraps the linter
  // in `bundle exec`, and the WRAPPER fails before the linter runs. It exits 1 —
  // indistinguishable by code from "malformed annotations found" — writes nothing
  // to stdout, and puts the only account of what happened on stderr. Dropping
  // that line leaves the reader debugging the wrong thing.
  it("quotes the stderr explaining why no document was written", async () => {
    await rejects(
      lintIntentAnnotations.run(
        {},
        toolContext({
          runCommand: stubCommand({
            code: 1,
            stdout: "",
            stderr: "bundler: command not found: specguard-lint\nInstall missing gem executables with `bundle install`",
          }).runCommand,
        }),
      ),
      /bundler: command not found[\s\S]*bundle install/,
    );
  });

  it("says stderr was empty too, rather than quoting nothing", async () => {
    await rejects(
      lintIntentAnnotations.run(
        {},
        toolContext({ runCommand: stubCommand({ code: 0, stdout: "", stderr: "  " }).runCommand }),
      ),
      /wrote nothing on stderr either/,
    );
  });

  // A no-document run must never read as clean, whichever branch it takes.
  it("never calls a document-less run clean", async () => {
    for (const stderr of ["", "bundler: command not found: specguard-lint"]) {
      await rejects(
        lintIntentAnnotations.run(
          {},
          toolContext({ runCommand: stubCommand({ code: 0, stdout: "", stderr }).runCommand }),
        ),
        /is NOT a clean run/,
      );
    }
  });

  it("refuses unparseable output", async () => {
    const error = await rejects(
      lintIntentAnnotations.run({}, toolContext({ runCommand: stubCommand({ stdout: "not json" }).runCommand })),
      /was not JSON/,
    );

    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("blames truncation for a cut-off document, not the linter's output", async () => {
    // A 4 MB ceiling on a giant suite's output is this bridge's decision, and the
    // document it cuts in half does not parse. Reporting that as "specguard-lint's
    // output was not JSON" names the wrong cause and withholds the fix, which is
    // to ask for less.
    const error = await rejects(
      lintIntentAnnotations.run(
        {},
        toolContext({
          runCommand: stubCommand({
            stdout: '{"ok": true, "findings": [{"file": "spec/a_sp',
            stdoutTruncated: true,
          }).runCommand,
        }),
      ),
      /truncated it and the JSON document is incomplete/,
    );

    assert.match(error.message, /4 MB/);
    assert.match(error.message, /`paths`/);
    assert.doesNotMatch(error.message, /was not JSON/);
    assert.ok(error instanceof CommandError, `expected a CommandError, got ${error.name}`);
  });

  it("refuses a path that would be read as a flag", async () => {
    // `--version` as a "path" would exit 0 having checked nothing — a false
    // clean, which is the exact failure this toolchain exists to prevent.
    await rejects(
      lintIntentAnnotations.run({ paths: ["--version"] }, toolContext()),
      /cannot start with "-"/,
    );
  });

  it("refuses an empty paths array rather than auditing the whole suite", async () => {
    // Passed through, `paths: []` gives the linter no positional arguments and it
    // checks EVERY spec file — so "check nothing" would come back as a clean bill
    // of health for the entire suite. Normalising it to "not given" produces the
    // identical argv, so only an error actually prevents it.
    const command = stubCommand({ stdout: report() });

    await rejects(
      lintIntentAnnotations.run({ paths: [] }, toolContext({ runCommand: command.runCommand })),
      /names no file, which selects nothing to check/,
    );

    assert.equal(command.calls.length, 0, "the linter must not have been run at all");
  });

  it("refuses a paths array of blanks the same way, since it selects nothing too", async () => {
    await rejects(lintIntentAnnotations.run({ paths: ["  "] }, toolContext()), /every entry was blank/);
  });

  it("trims a path before the leading-dash check, so a space cannot smuggle a flag past it", async () => {
    await rejects(lintIntentAnnotations.run({ paths: [" --version"] }, toolContext()), /cannot start with "-"/);
  });

  it("rejects arguments of the wrong type", async () => {
    await rejects(lintIntentAnnotations.run({ changed: "yes" }, toolContext()), /must be a boolean/);
    await rejects(lintIntentAnnotations.run({ project_dir: 7 }, toolContext()), /must be a string/);
    await rejects(lintIntentAnnotations.run({ paths: "spec/a_spec.rb" }, toolContext()), /must be an array/);
    await rejects(lintIntentAnnotations.run({ paths: [1] }, toolContext()), /only strings/);
  });
});

/**
 * `project_dir` is MODEL-supplied — an agent guesses a repository root — so it is
 * the likeliest thing about a call to be wrong, and it becomes `spawn`'s `cwd`.
 * Node reports a missing `cwd` with the same ENOENT as a missing binary, so
 * unchecked it is answered with "specguard-lint is not on this server's PATH; set
 * SPECGUARD_LINT_COMMAND" — which is wrong in every clause, names the one thing
 * that was right, and points the agent at MCP server config it cannot reach.
 */
describe("lint_intent_annotations — a bad project_dir blames project_dir", () => {
  it("names project_dir when the directory does not exist, and does not accuse the command", async () => {
    const command = stubCommand({ stdout: report() });

    const error = await rejects(
      lintIntentAnnotations.run(
        { project_dir: "/definitely/not/here" },
        toolContext({ runCommand: command.runCommand }),
      ),
      /`project_dir` "\/definitely\/not\/here" does not exist/,
    );

    assert.doesNotMatch(error.message, /PATH/);
    assert.doesNotMatch(error.message, /SPECGUARD_LINT_COMMAND/);
    assert.equal(command.calls.length, 0, "nothing should be spawned against a directory that is not there");
  });

  it("distinguishes a file from a directory, and says which to pass instead", async () => {
    const file = join(REAL_DIR, "Gemfile");
    writeFileSync(file, "source 'https://rubygems.org'\n");

    const error = await rejects(
      lintIntentAnnotations.run({ project_dir: file }, toolContext()),
      /is not a directory/,
    );

    assert.match(error.message, /`paths`/);
  });

  it("reports where a relative project_dir actually resolved to", async () => {
    // Resolved against the SERVER's working directory, which is not the agent's
    // and is not visible to it — so the path that was really used is the useful
    // half of the message.
    const error = await rejects(
      lintIntentAnnotations.run({ project_dir: "not-a-real-subdir-9f3a" }, toolContext()),
      /a relative path, resolved against this server's working directory/,
    );

    assert.match(error.message, new RegExp(escapeRegExp(resolve("not-a-real-subdir-9f3a"))));
  });

  it("still tells an operator about SPECGUARD_LINT_COMMAND when the BINARY is the missing thing", async () => {
    // The hint is not lost, only moved: the tool supplies it to runCommand, which
    // uses it on the missing-binary path only. (run-command.test.ts drives the
    // real spawn; this asserts the tool passes the hint at all.)
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run({}, toolContext({ runCommand: command.runCommand }));

    assert.match(String(command.calls[0]?.options?.notFoundHint), /SPECGUARD_LINT_COMMAND/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
