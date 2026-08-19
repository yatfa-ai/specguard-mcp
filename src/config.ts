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
 *
 * == TWO KEY VARIABLES, because SpecGuard has two credentials that refuse each
 * == other
 *
 * `Api::BaseController` discriminates on the token's PREFIX *before any table is
 * read*, and answers 401 on a mismatch without a lookup: `sgk_` names ONE
 * repository (`GET /api/v1/repository`, `POST /api/v1/ingest`), `sgu_` names a
 * PERSON (`GET /api/v1/repositories`). `UserApiKey::TOKEN_PREFIX` says the two
 * prefixes are deliberately the same length so neither can be a prefix of the
 * other — the mutual refusal is designed, not incidental.
 *
 * One variable therefore cannot serve both: whichever kind it holds, the tools
 * needing the other kind 401. So there are two, read independently, and neither
 * is required — an operator who only ever calls the repository tool sets only
 * `SPECGUARD_API_KEY`, exactly as before this existed. Prefix-dispatching over a
 * single variable was the alternative and it cannot work: an operator wanting
 * both kinds of tool needs both keys present at once.
 *
 * Which variable a tool reads is then carried onto `ApiConfig` alongside the
 * value — see `Credential` — for the same reason `endpointVariable` is: a
 * diagnostic that names the wrong variable sends an operator to fix something
 * they never set.
 */
export interface Config {
  /** SpecGuard deployment root, trailing slash stripped. `undefined` when unset. */
  readonly endpoint: string | undefined;
  /**
   * WHICH variable the endpoint was read from — so a message about a bad value
   * can name the variable the operator actually set.
   *
   * Without this, someone who followed the brief and set `SPECGUARD_URL` to a
   * malformed value would be told to go and fix `SPECGUARD_ENDPOINT`, which they
   * never set. Accepting two spellings is only a kindness if the diagnostics
   * speak the one that was used.
   */
  readonly endpointVariable: EndpointVariable | undefined;
  /** An `sgk_…` repository API key, from `SPECGUARD_API_KEY`. `undefined` when unset. */
  readonly apiKey: string | undefined;
  /**
   * An `sgu_…` user API key, from `SPECGUARD_USER_API_KEY`. `undefined` when unset.
   *
   * A SECOND slot rather than a second meaning for the first one — see the note
   * at the top of this file. It is minted from the account page
   * (`/account`) and speaks for a person; the repository key is minted per
   * repository and speaks for one repository. Neither deployment endpoint will
   * accept the other's token, so the two values live in two places here too.
   */
  readonly userApiKey: string | undefined;
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
  // WHICH variable is in play is decided ONCE, and the value is then read from
  // the variable that answer names. An earlier version derived the two
  // separately — the name via `presence()` (blank is unset) and the value via
  // `??` (blank is a value) — and the two rules disagreed on exactly one input:
  // a blank `SPECGUARD_ENDPOINT` alongside a good `SPECGUARD_URL` made `??`
  // return the empty string, so the alias was never consulted and the operator
  // was told the endpoint was unset while looking at the one they had set. That
  // is the silent no-op the alias exists to prevent, and a templated MCP client
  // `env` block with every key present and only some filled in is the ordinary
  // way to produce it. Reading through the chosen name makes the two
  // structurally incapable of disagreeing, rather than agreeing by coincidence.
  const endpointVariable =
    presence(env["SPECGUARD_ENDPOINT"]) !== undefined
      ? "SPECGUARD_ENDPOINT"
      : presence(env["SPECGUARD_URL"]) !== undefined
        ? "SPECGUARD_URL"
        : undefined;

  return {
    endpoint: endpointVariable === undefined ? undefined : normaliseEndpoint(env[endpointVariable]),
    endpointVariable,
    apiKey: presence(env["SPECGUARD_API_KEY"]),
    userApiKey: presence(env["SPECGUARD_USER_API_KEY"]),
    lintCommand: lintCommand.length > 0 ? lintCommand : DEFAULT_LINT_COMMAND,
    requestTimeoutMs: positiveInteger(env["SPECGUARD_TIMEOUT_MS"]) ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

/** What a tool that talks to the SpecGuard API needs, once both halves are known. */
export interface ApiConfig {
  readonly endpoint: string;
  /**
   * WHICH variable `endpoint` came from, carried one layer further out.
   *
   * `requireHttpUrl` already names the variable the operator set when it refuses
   * a malformed value, but the HTTP client one level down has its own diagnostics
   * — unreachable, 404, a body that is not JSON — and each of them tells the
   * operator to go and check the endpoint. Without the name here, all three said
   * `SPECGUARD_ENDPOINT` unconditionally, so someone who followed the brief and
   * set `SPECGUARD_URL` was sent to fix a variable they never set. Threading it
   * onto `ApiConfig` rather than re-deriving it means every HTTP-backed tool
   * added later inherits correct naming the same way it inherits the URL check.
   */
  readonly endpointVariable: EndpointVariable;
  readonly apiKey: string;
  /**
   * WHICH credential `apiKey` is — the variable it was read from, the prefix
   * that variable is expected to hold, and how to say both in a sentence.
   *
   * Exactly the treatment `endpointVariable` above gets, applied to the other
   * half, and for the same reason. `describeFailure` in
   * `support/specguard-api.ts` used to hardcode "SPECGUARD_API_KEY must be an
   * sgk_… key … keys are per-repository" into every 401, so the first
   * user-scoped tool routed through `getJson` would have inherited three
   * sentences that are all false of it — naming a variable its operator may
   * never have set. Carrying the answer rather than re-deriving it per tool is
   * what makes the next credential-scoped tool inherit correct naming the same
   * way it inherits the URL check.
   */
  readonly credential: Credential;
  readonly requestTimeoutMs: number;
}

export type EndpointVariable = "SPECGUARD_ENDPOINT" | "SPECGUARD_URL";

export type ApiKeyVariable = "SPECGUARD_API_KEY" | "SPECGUARD_USER_API_KEY";

/**
 * One of SpecGuard's two credential kinds, described well enough that a message
 * about it can be written without knowing which one it is.
 *
 * The two prose fields are sentence FRAGMENTS rather than whole messages on
 * purpose: the surrounding wording — "is not set in the MCP server's
 * environment", "SpecGuard rejected the API key (401)" — is the same for both
 * kinds and is written once, at the site that knows the situation. Only the
 * parts that genuinely differ between an `sgk_` key and an `sgu_` key live
 * here.
 */
export interface Credential {
  /** The environment variable this kind of key is read from. */
  readonly variable: ApiKeyVariable;
  /** The prefix SpecGuard requires of it, checked before any table is read. */
  readonly prefix: "sgk_" | "sgu_";
  /** Completes "… issued from ___" in a message about the variable being unset. */
  readonly issuedFrom: string;
  /** Completes "… issued by <deployment> ___" in a message about a 401. */
  readonly rejection: string;
}

/**
 * The `sgk_` key: one repository, and the same variable CI already sets.
 *
 * The 401 wording is unchanged from when this was the only credential — it is
 * accurate about this kind, and the reason a second kind exists is precisely
 * that it was never accurate about the other.
 */
export const REPOSITORY_CREDENTIAL: Credential = {
  variable: "SPECGUARD_API_KEY",
  prefix: "sgk_",
  issuedFrom: "issued from its API keys page",
  rejection:
    "for the repository you are asking about — keys are per-repository, and a " +
    "revoked key reads the same as a wrong one",
};

/**
 * The `sgu_` key: a person, and a variable nothing else in the toolchain reads.
 *
 * `specguard-rspec` ships runs with an `sgk_` key and has no notion of this one,
 * so an operator who already has CI reporting to SpecGuard does NOT already
 * have this variable — which is why the message says where to mint one rather
 * than assuming it is lying around.
 */
export const USER_CREDENTIAL: Credential = {
  variable: "SPECGUARD_USER_API_KEY",
  prefix: "sgu_",
  issuedFrom: "issued from your account page",
  rejection:
    "for your own SpecGuard account — a user key speaks for a person and lists what " +
    "that person may open, an sgk_… repository key is refused here without a lookup, " +
    "and a revoked key reads the same as a wrong one",
};

/**
 * The name to speak when no variable was set at all — the message is telling
 * someone to set one, and this is the spelling the rest of the toolchain reads.
 */
const DEFAULT_ENDPOINT_VARIABLE: EndpointVariable = "SPECGUARD_ENDPOINT";

/**
 * What a tool needing the `sgk_` REPOSITORY key requires — the endpoint and
 * `SPECGUARD_API_KEY`.
 *
 * Unchanged in name and in behaviour: every tool that reached the deployment
 * before this file grew a second credential calls exactly this, and gets exactly
 * what it got.
 */
export function requireApiConfig(config: Config): ApiConfig {
  return requireCredentialledApiConfig(config, config.apiKey, REPOSITORY_CREDENTIAL);
}

/**
 * What a tool needing the `sgu_` USER key requires — the endpoint and
 * `SPECGUARD_USER_API_KEY`.
 *
 * A sibling rather than a flag on `requireApiConfig`, which is the shape
 * `loadConfig`'s note at the top of this file already sanctioned: a tool asks
 * for what IT needs, so a tool needing neither key is unaffected and startup
 * still validates nothing. The two differ only in which value and which
 * `Credential` they pass to the one implementation below, so a fix to the
 * diagnostics reaches both and they cannot drift into describing the same
 * situation differently.
 */
export function requireUserApiConfig(config: Config): ApiConfig {
  return requireCredentialledApiConfig(config, config.userApiKey, USER_CREDENTIAL);
}

/**
 * Both halves or a legible failure — never one half and a surprise later.
 *
 * Reported together rather than one at a time: an operator who set neither
 * should learn that in one round trip instead of fixing a variable, re-calling,
 * and being told about the next one. That property is why the two `require*`
 * entry points share this body rather than each doing their own presence check:
 * "together" has to mean the endpoint AND whichever key the calling tool needs,
 * and a per-tool check would report them one at a time again.
 *
 * The endpoint is also PARSED here, not merely counted as present. It is spent
 * later inside `new URL(...)` in the HTTP client, where a malformed value throws
 * a bare `TypeError` — which is not a `SpecGuardMcpError`, so the server's error
 * boundary reads it as a defect and tells the agent "this is a bug in the
 * bridge, not in your project or configuration". For the commonest config typo
 * there is (omitting `https://`) that sentence is the exact opposite of the
 * truth, and it sends an agent looking in the one place the problem is not.
 * Validating here rather than at the call site is deliberate: every HTTP-backed
 * tool added later comes through this function and inherits the check.
 *
 * The KEY is deliberately NOT validated against `credential.prefix` here. The
 * deployment is the authority on whether a token is acceptable — it checks the
 * prefix, then the digest, then whether the key is revoked — and a second,
 * weaker copy of the first third of that rule on this side would refuse a token
 * SpecGuard would have accepted the moment the platform mints a third prefix.
 * The prefix is carried so a MESSAGE can name it, not so this file can enforce
 * it; the 401 branch of `describeFailure` is where a wrong-kind key is
 * diagnosed, with the deployment's own verdict in hand.
 */
function requireCredentialledApiConfig(
  config: Config,
  apiKey: string | undefined,
  credential: Credential,
): ApiConfig {
  const endpointVariable = config.endpointVariable ?? DEFAULT_ENDPOINT_VARIABLE;

  const missing: string[] = [];
  if (config.endpoint === undefined) missing.push(endpointVariable);
  if (apiKey === undefined) missing.push(credential.variable);

  if (missing.length > 0) {
    throw new ConfigError(
      `This tool talks to a SpecGuard deployment, and ${missing.join(" and ")} ` +
        `${missing.length === 1 ? "is" : "are"} not set in the MCP server's environment. ` +
        "Set them in your MCP client's server config " +
        `(${endpointVariable} is your deployment's root URL, ${credential.variable} ` +
        `an ${credential.prefix}… key ${credential.issuedFrom}). ` +
        "Tools that do not reach the deployment are unaffected.",
    );
  }

  return {
    endpoint: requireHttpUrl(config.endpoint as string, endpointVariable),
    endpointVariable,
    apiKey: apiKey as string,
    credential,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

/**
 * An absolute `http(s)` URL, or a `ConfigError` that names the variable and the
 * value it holds.
 *
 * Both failing shapes are worth naming because they fail in different places
 * without this. `sg.example.com` has no scheme and `new URL` rejects it
 * outright; `localhost:3000` is *accepted* by `new URL` — as protocol
 * `localhost:` with path `3000` — and instead dies much later as an unhelpful
 * transport error. An operator making either mistake made the same mistake, so
 * they get the same answer.
 */
function requireHttpUrl(endpoint: string, name: EndpointVariable): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(endpoint);
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ConfigError(
      `${name} is not a usable URL: ${JSON.stringify(endpoint)}. It must be your SpecGuard ` +
        "deployment's root URL including the scheme — for example " +
        "https://specguard.example.com, or http://localhost:3000 for a local deployment. " +
        `This is the MCP server's own environment: fix ${name} in your MCP client's server ` +
        "config. Nothing about your project or your arguments is wrong.",
    );
  }

  return endpoint;
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
