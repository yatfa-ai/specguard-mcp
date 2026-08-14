import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ArgumentError, CommandError } from "../errors.js";
import { MAX_OUTPUT_BYTES } from "../support/run-command.js";
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
          "under it. An empty list is an error, not a way to say 'everything'. " +
          "Cannot be combined with `changed`.",
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

    // Every argument is checked before anything is spawned, so a call that was
    // never going to run cannot leave a subprocess behind to explain.
    if (projectDir !== undefined) await requireProjectDir(projectDir);

    const argv = [...context.config.lintCommand, "--json"];
    if (changed === true) argv.push(base === undefined ? "--changed" : `--changed=${base}`);
    if (paths !== undefined) argv.push(...paths);

    const result = await context.runCommand(argv, {
      cwd: projectDir,
      notFoundHint: LINT_COMMAND_HINT,
    });

    // Exit 2 — and every signal death, which is the same "no verdict" outcome
    // wearing a different code. stderr is the diagnosis; there is no document.
    if (result.code !== 0 && result.code !== 1) {
      throw new CommandError(
        `specguard-lint could not check anything (exit ${result.code ?? `signal ${result.signal}`}). ` +
          `It reported:\n${result.stderr.trim() || "(nothing on stderr)"}`,
      );
    }

    const report = parseReport(result.stdout, result.stdoutTruncated, result.stderr);

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
 * What to try when `specguard-lint` is not on PATH.
 *
 * Passed to `runCommand` rather than baked into it: only this tool knows that
 * ITS command comes from `SPECGUARD_LINT_COMMAND`, and a shared helper that
 * names one tool's variable would misdirect every later tool that spawns
 * something else.
 */
const LINT_COMMAND_HINT =
  "Set SPECGUARD_LINT_COMMAND to the command that runs it here " +
  '(for a bundled Ruby project that is usually "bundle exec specguard-lint").';

/**
 * `project_dir` names a directory that exists, or the failure says exactly that.
 *
 * This check earns its place because of WHO supplies the argument. `project_dir`
 * is model-supplied — an agent guesses a repository root — which makes it the
 * likeliest thing about a call to this tool to be wrong. Unchecked it becomes
 * `spawn`'s `cwd`, and Node reports a missing `cwd` as ENOENT: the same code as
 * a missing binary. The answer to a mistyped path would then be "specguard-lint
 * is not on this server's PATH; set SPECGUARD_LINT_COMMAND" — every clause of it
 * wrong, and it names the one thing that was right. Worse, it points an agent at
 * MCP server configuration it usually cannot reach, to fix a working install, so
 * it will try again and fail identically.
 *
 * Checked here rather than in `run-command` because this is the only place the
 * argument's NAME is known, and naming `project_dir` is what turns this from a
 * message about the server into one the agent can act on unaided.
 */
async function requireProjectDir(projectDir: string): Promise<void> {
  let isDirectory: boolean;

  try {
    isDirectory = (await stat(projectDir)).isDirectory();
  } catch {
    throw new CommandError(
      `\`project_dir\` ${JSON.stringify(projectDir)} does not exist${resolvedNote(projectDir)}. ` +
        "Pass the absolute path of the project root — the directory holding its Gemfile and " +
        "spec/ — or omit `project_dir` to lint the directory this server was started in. " +
        "(specguard-lint itself was not the problem.)",
    );
  }

  if (!isDirectory) {
    throw new CommandError(
      `\`project_dir\` ${JSON.stringify(projectDir)} is not a directory${resolvedNote(projectDir)}. ` +
        "Pass the project root — the directory holding its Gemfile and spec/ — not a file inside " +
        "it. To lint one file, pass it in `paths` instead.",
    );
  }
}

/**
 * A relative `project_dir` is resolved against whatever directory this server
 * was started in, which is not the agent's working directory and is not
 * something the agent can see. When the two can differ, the path that was
 * actually used is the useful half of the message.
 */
function resolvedNote(projectDir: string): string {
  return isAbsolute(projectDir)
    ? ""
    : ` (a relative path, resolved against this server's working directory to ${JSON.stringify(resolve(projectDir))})`;
}

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

function parseReport(stdout: string, truncated: boolean, stderr: string): LintReport {
  const trimmed = stdout.trim();

  if (trimmed === "") {
    // stderr is carried, not dropped. An exit of 0 or 1 with an empty stdout is
    // most often produced by the WRAPPER in SPECGUARD_LINT_COMMAND — `bundle`,
    // `rbenv`, a docker shim — failing before the linter ever ran, and such a
    // wrapper explains itself on stderr and nowhere else. Withholding that line
    // to speculate about the variable instead leaves the one reader who could
    // fix it guessing, which is the failure mode the sibling branches below
    // (and the exit-2 branch above) already avoid by quoting their evidence.
    const reported = stderr.trim();

    throw new CommandError(
      "specguard-lint exited with a verdict but wrote no JSON document, so there are no " +
        "findings to report — this is NOT a clean run." +
        (reported === ""
          ? " It wrote nothing on stderr either. The command in SPECGUARD_LINT_COMMAND may not be " +
            "specguard-lint, or may be a version older than the one that added --json."
          : `\n\nIt reported:\n${truncate(reported)}\n\n` +
            "That is the command in SPECGUARD_LINT_COMMAND reporting why it produced no document."),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Truncation is checked FIRST, because it is a cause and "not JSON" is only
    // the symptom it produces. A document this bridge cut in half does not parse,
    // and blaming the linter's output for it would name the wrong cause — and
    // withhold the one thing that would fix it, which is asking for less.
    if (truncated) {
      throw new CommandError(
        `specguard-lint produced more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB of output, so ` +
          "this bridge truncated it and the JSON document is incomplete — no findings could be " +
          "read from it. Narrow the run with `paths`, or with `changed` to check only what " +
          "differs from the merge base.",
      );
    }

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
  if (typeof value !== "string") throw new ArgumentError(`\`${field}\` must be a string.`);
  // Trimmed, not merely tested for blankness. `project_dir` becomes a `cwd`, so
  // " /srv/app" — a path an agent produces by concatenating one — would otherwise
  // be a directory that cannot exist, reported as a directory that does not.
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ArgumentError(`\`${field}\` must be a boolean.`);
  return value;
}

/**
 * A non-empty list of non-empty paths, or nothing.
 *
 * `paths: []` is REFUSED rather than normalised. Both readings of it are bad and
 * neither is what an agent meant: passed through, an empty list leaves the
 * linter with no positional arguments and it audits EVERY spec file in the
 * project, so "check nothing" comes back as a clean bill of health for the whole
 * suite; silently treated as "not given", the same thing happens by a different
 * route. A tool whose entire purpose is to stop a check that examined nothing
 * from looking like a check that found nothing cannot itself answer an empty
 * selection with "all clean". So it is an error, and the message says which of
 * the two the caller probably wanted.
 */
function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ArgumentError(`\`${field}\` must be an array of strings.`);

  const entries = value.map((entry) => {
    if (typeof entry !== "string") throw new ArgumentError(`\`${field}\` must contain only strings.`);
    // Trimmed BEFORE the checks below, so a stray space cannot smuggle an entry
    // past the leading-dash guard as " --version".
    return entry.trim();
  });

  const nonEmpty = entries.filter((entry) => entry !== "");

  if (nonEmpty.length === 0) {
    throw new CommandError(
      `\`${field}\` was given but names no file${entries.length === 0 ? "" : " (every entry was blank)"}, ` +
        "which selects nothing to check. Omit `paths` to check every spec file in the project, " +
        "or list the files you want checked — an empty selection is not treated as “everything”, " +
        "because a run that checked nothing must never come back clean.",
    );
  }

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

  return nonEmpty;
}
