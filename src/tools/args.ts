import { ArgumentError } from "../errors.js";

/**
 * The tool-agnostic argument coercions — the shape checks every tool needs and
 * no tool should re-derive.
 *
 * == Why this file exists at all
 *
 * `optionalString` was written twice, once per tool file, in the same commit
 * that created both. The copies then diverged on the one thing a copy is most
 * likely to get wrong: which of the four error classes to throw. One picked
 * `ApiError`, the other `CommandError`, with byte-identical message strings —
 * so the same malformed argument was reported as two different kinds of failure
 * depending on which tool received it. That was repaired by re-pointing both
 * throws at `ArgumentError`, but repairing two copies is not the same as having
 * one, and the next tool author still has to choose the class again from
 * scratch.
 *
 * `types.ts` promises that adding a tool is "two mechanical edits with no
 * third". Hand-copying these coercions and re-picking an error class was the
 * unlisted third edit. This file removes it.
 *
 * == What belongs here, and what does not
 *
 * Only checks about the SHAPE of a value — is it a string, is it a boolean —
 * whose failure is always `ArgumentError`, the class meaning "the call was
 * malformed and the agent can fix it unaided on the next call".
 *
 * A check that reasons about what an argument MEANS to one particular wrapped
 * tool stays with that tool. `optionalStringArray` in
 * `lint-intent-annotations.ts` is the standing example: its refusals of an
 * empty list and of a leading dash are about the linter's own argument grammar
 * — what `paths: []` would make `specguard-lint` audit, what its OptionParser
 * would read a `-` as — and they throw `CommandError` for that reason. Moving
 * it here would drag one tool's semantics into a file the next tool imports.
 *
 * == Placement
 *
 * `src/tools/` rather than `src/support/`. `src/support/` holds injected
 * outside-world capabilities — `run-command.ts`, `specguard-api.ts` — which
 * reach tools through `ToolContext` and are substituted in tests. These are
 * pure functions with no context and nothing to inject: they are part of the
 * tool-authoring contract, which lives here beside `types.ts`.
 */

/**
 * A non-blank string, or nothing.
 */
export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ArgumentError(`\`${field}\` must be a string.`);
  // Trimmed, not merely tested for blankness. `project_dir` becomes a `cwd`, so
  // " /srv/app" — a path an agent produces by concatenating one — would otherwise
  // be a directory that cannot exist, reported as a directory that does not.
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ArgumentError(`\`${field}\` must be a boolean.`);
  return value;
}
