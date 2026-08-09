import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lintIntentAnnotations from "../../src/tools/lint-intent-annotations.js";
import { rejects, stubCommand, toolContext } from "../support/stubs.js";

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

    await lintIntentAnnotations.run({ project_dir: "/srv/app" }, toolContext({ runCommand: command.runCommand }));

    assert.equal(command.calls[0]?.options?.cwd, "/srv/app");
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
    await rejects(
      lintIntentAnnotations.run(
        {},
        toolContext({ runCommand: stubCommand({ code: 2, stdout: "", stderr: "error: could not load schema" }).runCommand }),
      ),
      /could not load schema/,
    );
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

  it("refuses unparseable output", async () => {
    await rejects(
      lintIntentAnnotations.run({}, toolContext({ runCommand: stubCommand({ stdout: "not json" }).runCommand })),
      /was not JSON/,
    );
  });

  it("refuses a path that would be read as a flag", async () => {
    // `--version` as a "path" would exit 0 having checked nothing — a false
    // clean, which is the exact failure this toolchain exists to prevent.
    await rejects(
      lintIntentAnnotations.run({ paths: ["--version"] }, toolContext()),
      /cannot start with "-"/,
    );
  });

  it("treats an empty paths array as 'not given' rather than as 'check everything'", async () => {
    const command = stubCommand({ stdout: report() });

    await lintIntentAnnotations.run({ paths: [] }, toolContext({ runCommand: command.runCommand }));

    assert.deepEqual(command.calls[0]?.argv, ["specguard-lint", "--json"]);
  });

  it("rejects arguments of the wrong type", async () => {
    await rejects(lintIntentAnnotations.run({ changed: "yes" }, toolContext()), /must be a boolean/);
    await rejects(lintIntentAnnotations.run({ project_dir: 7 }, toolContext()), /must be a string/);
    await rejects(lintIntentAnnotations.run({ paths: "spec/a_spec.rb" }, toolContext()), /must be an array/);
    await rejects(lintIntentAnnotations.run({ paths: [1] }, toolContext()), /only strings/);
  });
});
