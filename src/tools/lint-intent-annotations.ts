import { CommandError } from "../errors.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

/**
 * `specguard-lint --json` as a tool — the `@intent` linter, which is shipped
 * today in `specguard-rspec` (`bin/specguard-lint`, SPGD-12 §1).
 *
 * == Why this wraps the JSON renderer and not the human one
 *
 * The gem grew `--json` in SPGD-305 precisely so a consumer gets *which file,
 * which line, which rule* as data instead of a prose format to regex. An agent
 * is that consumer. Passing `--json` unconditionally is what makes this a thin
 * client rather than a parser: the document goes back as the linter emitted it,
 * key for key, and this file contains no knowledge of the OpenTestIntent schema,
 * no finding shape, and no rule about what makes an annotation valid.
 *
 * == The exit code is a verdict, not an error
 *
 * The linter's contract is three-valued and the mapping is the one decision
 * this tool actually makes:
 *
 *   0 — every annotation checked was valid (including "there were none").
 *   1 — at least one annotation is malformed. A SUCCESSFUL tool call with
 *       findings in it. Reporting exit 1 as a tool error would tell the agent
 *       the linter broke, when what happened is the linter worked and the code
 *       is wrong — and an agent that reads "tool failed" retries the tool
 *       instead of fixing the annotation.
 *   2 — the linter could not do its job. A tool error, and the only one. The
 *       gem deliberately emits NO document on this path (a `{"ok": false,
 *       "findings": []}` for a run that checked nothing is how a gate that
 *       checked nothing gets mistaken for one that found nothing), so the prose
 *       it wrote to stderr is the entire diagnosis and is passed through.
 *
 * `ok` is read off the document rather than re-derived from the exit code, and
 * the exit code is reported beside it, so an agent can see the two agree.
 *
 * == What is deliberately not validated here
 *
 * `--changed` together with explicit paths is misuse, and the linter exits 2
 * saying so. This tool does not pre-empt that. Re-implementing the rule would
 * put a second copy of the linter's argument grammar in a different language,
 * free to drift the day the gem adds a flag — and the tool would then be
 * enforcing a contract it does not own. The schema documents the conflict; the
 * linter adjudicates it.
 */
const lintIntentAnnotations: ToolDefinition = {
  name: "lint_intent_annotations",

  title: "Lint @intent annotations",

  description:
    "Validate the `@intent:` annotations in a Ruby project's RSpec files against the " +
    "OpenTestIntent schema, using that project's own `specguard-lint`. Returns each finding as " +
    "structured data — file, line, failure kind (schema / extraction / parse / read), and every " +
    "violated rule — so a malformed annotation can be fixed without reading a CI log. " +
    "Use it after writing or editing `@intent:` annotations, or to audit a suite. " +
    "A MISSING annotation is never a failure: adoption is gradual by design, so a suite with no " +
    "annotations at all lints clean. Runs locally and needs no SpecGuard deployment or API key.",

  inputSchema: {
    type: "object",
    properties: {
      project_dir: {
        type: "string",
        description:
          "Absolute path to the Ruby project to lint — the directory holding its Gemfile and " +
          "spec/. Defaults to the directory this server was started in.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific spec files to check, relative to project_dir. Omit to check every *_spec.rb " +
          "under it. Cannot be combined with `changed`.",
      },
      changed: {
        type: "boolean",
        description:
          "Check only spec files that differ from the merge base with the default branch — the " +
          "mode CI uses. Cannot be combined with `paths`.",
      },
      base: {
        type: "string",
        description:
          "Diff `changed` against this git ref instead of the default merge base. Ignored unless " +
          "`changed` is true.",
      },
    },
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const projectDir = optionalString(args["project_dir"], "project_dir");
    const paths = optionalStringArray(args["paths"], "paths");
    const changed = optionalBoolean(args["changed"], "changed");
    const base = optionalString(args["base"], "base");

    const argv = [...context.config.lintCommand, "--json"];
    if (changed === true) argv.push(base === undefined ? "--changed" : `--changed=${base}`);
    if (paths !== undefined) argv.push(...paths);

    const result = await context.runCommand(argv, { cwd: projectDir });

    // Exit 2 — and every signal death, which is the same "no verdict" outcome
    // wearing a different code. stderr is the diagnosis; there is no document.
    if (result.code !== 0 && result.code !== 1) {
      throw new CommandError(
        `specguard-lint could not check anything (exit ${result.code ?? `signal ${result.signal}`}). ` +
          `It reported:\n${result.stderr.trim() || "(nothing on stderr)"}`,
      );
    }

    const report = parseReport(result.stdout);

    return {
      // The provenance line the gem writes to stderr on EVERY run names which
      // implementation produced the verdicts (Ruby, or the Go port when
      // SPECGUARD_VALIDATE_INTENT is set). It is deliberately absent from the
      // document — SPGD-247 keeps it in one place — so dropping stderr here
      // would make "which validator ran" unanswerable from this tool.
      text: renderText(report, result.stderr, result.code),
      structured: {
        exit_code: result.code,
        ok: report.ok,
        report,
        linter_stderr: result.stderr.trim(),
      },
    };
  },
};

export default lintIntentAnnotations;

/**
 * The linter's document, echoed through rather than re-modelled.
 *
 * Typed as `unknown`-ish on purpose: this server does not own the shape, the
 * gem does, and a field added there should reach the agent without a release
 * here. All that is asserted is that stdout parsed and carries the one key this
 * file reads.
 */
interface LintReport extends Record<string, unknown> {
  ok?: unknown;
}

function parseReport(stdout: string): LintReport {
  const trimmed = stdout.trim();

  if (trimmed === "") {
    throw new CommandError(
      "specguard-lint exited with a verdict but wrote no JSON document. " +
        "That should not happen with --json; the configured SPECGUARD_LINT_COMMAND may not be " +
        "specguard-lint, or may be a version older than the one that added --json.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CommandError(
      `specguard-lint's output was not JSON, so no findings could be read. It wrote:\n${truncate(trimmed)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CommandError("specguard-lint's --json output was not a JSON object.");
  }

  return parsed as LintReport;
}

/**
 * The text rendering, built FROM the same parsed document the structured half
 * carries — never a second pass over the raw output. A tool whose two renderings
 * of one call can disagree is worse than one that returns only prose, because
 * the disagreement is invisible from outside.
 */
function renderText(report: LintReport, stderr: string, code: number | null): string {
  const provenance = stderr.trim();

  return [
    `specguard-lint exited ${code} (${code === 0 ? "no malformed annotations" : "malformed annotations found"}).`,
    provenance === "" ? undefined : provenance,
    JSON.stringify(report, null, 2),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

function truncate(value: string, limit = 2000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CommandError(`\`${field}\` must be a string.`);
  return value.trim() === "" ? undefined : value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new CommandError(`\`${field}\` must be a boolean.`);
  return value;
}

/**
 * A non-empty list of non-empty strings, or nothing.
 *
 * The empty-array case is the one worth guarding: passing `paths: []` through
 * would run the linter with no positional arguments, which selects EVERY spec
 * file in the project — an agent asking to check nothing would instead audit the
 * whole suite and be told it was clean. Normalising it to "not given" makes that
 * explicit rather than accidental.
 */
function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new CommandError(`\`${field}\` must be an array of strings.`);

  const entries = value.map((entry) => {
    if (typeof entry !== "string") throw new CommandError(`\`${field}\` must contain only strings.`);
    return entry;
  });

  const nonEmpty = entries.filter((entry) => entry.trim() !== "");

  // A leading `-` would be read by the linter's OptionParser as a flag rather
  // than a path — `--version` would exit 0 having checked nothing, which is the
  // false-clean result this whole toolchain exists to prevent. Paths are paths.
  for (const entry of nonEmpty) {
    if (entry.startsWith("-")) {
      throw new CommandError(
        `\`${field}\` entries are file paths and cannot start with "-" (got ${JSON.stringify(entry)}).`,
      );
    }
  }

  return nonEmpty.length === 0 ? undefined : nonEmpty;
}
