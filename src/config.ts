import { ConfigError } from "./errors.js";

/**
 * Where configuration comes from, and — more importantly — WHEN it is read.
 *
 * == Nothing is required to start the server
 *
 * The bootstrap ships two tools with genuinely different needs: the lint tool
 * shells out to a local binary and needs no SpecGuard deployment at all, while
 * the repository tool needs both an endpoint and a key. A server that validated
 * everything at boot would refuse to start for someone who installed it purely
 * to lint — and MCP's failure mode for that is not a helpful message, it is a
 * client reporting "server exited" with the reason buried in a log nobody
 * reads.
 *
 * So `loadConfig` never throws. Each tool asks for what it needs, at call time,
 * through the `require*` helpers below, and a missing variable comes back as one
 * legible sentence in a tool result the agent can act on. This is also the
 * property that keeps the toolset growable: a tool added later that needs a
 * third variable adds a `require*` helper and changes nothing about startup.
 *
 * == SPECGUARD_ENDPOINT, with SPECGUARD_URL as an accepted alias
 *
 * `SPECGUARD_ENDPOINT` is the name the shipped `specguard-rspec` gem already
 * reads, so a repository whose CI posts runs to SpecGuard has it set — that is
 * the whole reason this server borrows the name rather than coining one. The
 * SPGD-310 brief writes it as `SPECGUARD_URL`, so that spelling is accepted
 * too rather than left as a silent no-op for anyone who follows the ticket.
 * `SPECGUARD_ENDPOINT` wins when both are set and disagree, because it is the
 * one the rest of the toolchain is already reading.
 */
export interface Config {
  /** SpecGuard deployment root, trailing slash stripped. `undefined` when unset. */
  readonly endpoint: string | undefined;
  /** An `sgk_…` API key. `undefined` when unset. */
  readonly apiKey: string | undefined;
  /**
   * The command that runs the `@intent` linter, already tokenised.
   *
   * Defaults to `["specguard-lint"]`. Most Ruby projects need the gem resolved
   * through their bundle, which is a deployment fact this server cannot guess —
   * set `SPECGUARD_LINT_COMMAND="bundle exec specguard-lint"` for those. It is
   * tokenised here rather than handed to a shell, so nothing an agent passes as
   * a tool argument can reach one.
   */
  readonly lintCommand: readonly string[];
  /** How long an HTTP call to SpecGuard may take, in milliseconds. */
  readonly requestTimeoutMs: number;
}

export const DEFAULT_LINT_COMMAND: readonly string[] = ["specguard-lint"];
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Reads config from an environment. Never throws — see the note above. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const lintCommand = tokenise(env["SPECGUARD_LINT_COMMAND"]);

  return {
    endpoint: normaliseEndpoint(env["SPECGUARD_ENDPOINT"] ?? env["SPECGUARD_URL"]),
    apiKey: presence(env["SPECGUARD_API_KEY"]),
    lintCommand: lintCommand.length > 0 ? lintCommand : DEFAULT_LINT_COMMAND,
    requestTimeoutMs: positiveInteger(env["SPECGUARD_TIMEOUT_MS"]) ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

/** What a tool that talks to the SpecGuard API needs, once both halves are known. */
export interface ApiConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
}

/**
 * Both halves or a legible failure — never one half and a surprise later.
 *
 * Reported together rather than one at a time: an operator who set neither
 * should learn that in one round trip instead of fixing a variable, re-calling,
 * and being told about the next one.
 */
export function requireApiConfig(config: Config): ApiConfig {
  const missing: string[] = [];
  if (config.endpoint === undefined) missing.push("SPECGUARD_ENDPOINT");
  if (config.apiKey === undefined) missing.push("SPECGUARD_API_KEY");

  if (missing.length > 0) {
    throw new ConfigError(
      `This tool talks to a SpecGuard deployment, and ${missing.join(" and ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set in the MCP server's environment. ` +
        "Set them in your MCP client's server config " +
        "(SPECGUARD_ENDPOINT is your deployment's root URL, SPECGUARD_API_KEY an sgk_… key " +
        "issued from its API keys page). Tools that do not reach the deployment are unaffected.",
    );
  }

  return {
    endpoint: config.endpoint as string,
    apiKey: config.apiKey as string,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

/**
 * A trailing slash on the endpoint would produce `https://host//api/v1/…` once
 * joined. Harmless on most servers and confusing in every error message that
 * echoes the URL back, so it is stripped once here rather than defended against
 * at each call site.
 */
function normaliseEndpoint(raw: string | undefined): string | undefined {
  const value = presence(raw);
  return value === undefined ? undefined : value.replace(/\/+$/, "");
}

/**
 * Blank is unset.
 *
 * `SPECGUARD_API_KEY=` in a CI environment file is somebody turning the
 * integration off, and treating it as a present-but-empty key would send
 * `Authorization: Bearer ` and turn a configuration mistake into a 401 —
 * a failure that names the wrong cause. The gem's `ValidatorBackend` collapses
 * unset and blank for the same reason.
 */
function presence(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function positiveInteger(raw: string | undefined): number | undefined {
  const value = Number(presence(raw));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Splits a configured command into argv WITHOUT a shell, honouring single and
 * double quotes so a path with a space survives.
 *
 * A shell is not used anywhere in this server, and this function is why it does
 * not need to be: `spawn` receives a program and a list, so no argument — least
 * of all a file path an agent passed to a tool — is ever parsed as syntax.
 */
export function tokenise(raw: string | undefined): string[] {
  const value = presence(raw);
  if (value === undefined) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of value) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  if (started) tokens.push(current);

  return tokens;
}
