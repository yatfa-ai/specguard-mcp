/**
 * Typed failures the server knows how to turn into an MCP tool error.
 *
 * The distinction that matters here is between a bug (which should crash loudly
 * and be fixed) and an *expected* failure the calling agent can act on — a
 * missing API key, a SpecGuard deployment saying 401, a linter binary that is
 * not on PATH. The second kind must reach the agent as a tool result it can
 * read, never as a dead stdio pipe: an MCP server that exits on a bad API key
 * takes every other tool down with it, including the ones that never needed the
 * key.
 */

/** Base for every failure that is a legitimate answer rather than a defect. */
export class SpecGuardMcpError extends Error {
  override readonly name: string = "SpecGuardMcpError";
}

/**
 * The environment does not carry what this tool needs.
 *
 * Raised at CALL time, never at boot — see `resolveApiConfig`. The message names
 * the variable, because "unauthorized" is not something an agent can fix and
 * "set SPECGUARD_API_KEY" is.
 */
export class ConfigError extends SpecGuardMcpError {
  override readonly name = "ConfigError";
}

/** The SpecGuard deployment was reached and refused, or answered unusably. */
export class ApiError extends SpecGuardMcpError {
  override readonly name = "ApiError";

  /** The HTTP status, when there was a response at all. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * The arguments the agent supplied are not the shape the schema advertises.
 *
 * What separates this from its two neighbours is WHERE IN THE CALL it is raised:
 * argument shape is checked first, so this throws BEFORE any config is resolved
 * and BEFORE any command is spawned. Nothing was reached and refused, so it is
 * not an `ApiError`; nothing was run and broke, so it is not a `CommandError`.
 * Both of those say the fault lies somewhere the agent cannot see, and invite a
 * retry that cannot help. This is the one failure class the agent can fix
 * unaided, on the next call, from the message alone.
 *
 * Deliberately NOT named `TypeError`: `describeError` treats the global
 * `TypeError` as the canonical non-`SpecGuardMcpError` defect, and shadowing it
 * would invert that branch.
 */
export class ArgumentError extends SpecGuardMcpError {
  override readonly name = "ArgumentError";
}

/**
 * A wrapped command could not be run, or broke while running.
 *
 * NOT "the command reported a problem with your code" — that is a finding and
 * goes back as a successful result. This is the tool itself being unusable,
 * which for `specguard-lint` is precisely its documented exit 2.
 */
export class CommandError extends SpecGuardMcpError {
  override readonly name = "CommandError";
}
