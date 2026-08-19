import { requireApiConfig, requireUserApiConfig, type ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";

/**
 * The SpecGuard HTTP client — a Bearer key and a path, and nothing else.
 *
 * Authorization is enforced by the deployment (`Api::BaseController`), never
 * here: this carries the operator's key and reports what came back. The bridge
 * adds no credentials of its own and makes no access decisions, so there is no
 * second place for the permission model to be got wrong.
 */
export async function getJson(
  api: ApiConfig,
  path: string,
  query: Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  const url = new URL(`${api.endpoint}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const { response, body } = await fetchWithTimeout(url, api, fetchImpl);

  if (!response.ok) throw describeFailure(response.status, body, api);

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(
      `${api.endpoint} answered ${response.status} but the body was not JSON. ` +
        `Check that ${api.endpointVariable} points at a SpecGuard deployment and not, say, a proxy ` +
        "or login page.",
      response.status,
    );
  }
}

/** A response and the body that came with it — never one without the other. */
interface FetchedBody {
  readonly response: Response;
  readonly body: string;
}

/**
 * Tells "the deadline won the race" apart from any value a phase could produce.
 *
 * A resolved sentinel rather than a rejecting deadline promise: a promise that
 * rejects has to be raced against every phase or its rejection is unhandled, and
 * an unhandled rejection on stdio takes the whole transport down — the failure
 * mode `errors.ts` exists to avoid.
 */
const TIMED_OUT = Symbol("specguard-api deadline");

/**
 * Headers AND body under ONE deadline.
 *
 * `SPECGUARD_TIMEOUT_MS` is documented in `config.ts` as how long an HTTP call
 * to SpecGuard may take, and a call is not over when its headers arrive. An
 * `AbortController` armed only around `fetchImpl` is disarmed the moment the
 * response object resolves, so a deployment that answers `200 OK` and then
 * dribbles — or freezes — the body leaves the body read awaiting with no
 * deadline and no live signal. In an MCP server that is not a slow answer: it is
 * a tool call, and therefore the agent that called it, which never returns.
 *
 * ONE TOTAL BUDGET, not one per phase. `requestTimeoutMs` bounds the whole call:
 * headers and body share it, so a response whose headers took 29s of a 30s
 * budget has 1s left in which to deliver its body. The sibling transport in
 * `specguard-rspec` (`lib/specguard/rspec/transport.rb`) gives each phase its own
 * full `@timeout` because `Net::HTTP` exposes exactly that knob and no other;
 * here the deadline is ours to place, and a single total is both stricter and
 * the thing an operator who set one number actually meant.
 *
 * The race is explicit rather than left to the abort signal. Aborting is still
 * done — it tears a real connection down instead of leaking it — but WHETHER an
 * aborted signal also errors an already-delivered body stream is a property of
 * the fetch implementation, and this function takes `fetchImpl` from its caller.
 * Racing the deadline here is what makes the bound hold for any implementation
 * rather than for one in particular.
 *
 * The body is read HERE, inside the deadline, rather than by the caller one
 * frame later, so there is no window in which the read is awaiting somewhere the
 * timer does not reach.
 */
async function fetchWithTimeout(
  url: URL,
  api: ApiConfig,
  fetchImpl: typeof globalThis.fetch,
): Promise<FetchedBody> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, api.requestTimeoutMs);
    // `unref` so a stalled body's timer cannot by itself hold the process open —
    // the same reason `run-command.ts` unrefs the timer that kills a hung child.
    timer.unref?.();
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${api.apiKey}`,
          Accept: "application/json",
          "User-Agent": "specguard-mcp",
        },
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (response === TIMED_OUT) throw timedOut(api);

    const body = await Promise.race([response.text(), deadline]);
    if (body === TIMED_OUT) throw timedOut(api);

    return { response, body };
  } catch (error) {
    // Already diagnosed above — a timeout, converted while the phase that hit it
    // was still known. Rethrown before the transport branch so a deadline can
    // never be re-described as "could not reach", which would name a cause that
    // is the opposite of what happened: the deployment was reached, and stopped.
    if (error instanceof ApiError) throw error;

    // A transport failure and a refusal are different problems with different
    // fixes, and "fetch failed" names neither. The endpoint is echoed because
    // the commonest cause by far is that it is wrong — and the variable is named
    // from the config rather than spelled out here, so an operator who set
    // SPECGUARD_URL is not sent to fix a variable they never set.
    if (controller.signal.aborted) throw timedOut(api);

    throw new ApiError(
      `Could not reach ${api.endpoint}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Check ${api.endpointVariable} and that the deployment is reachable from this machine.`,
    );
  } finally {
    // Cleared on every exit — success, HTTP failure, transport failure and
    // timeout alike — because the timer now outlives the fetch call itself.
    clearTimeout(timer);
  }
}

/**
 * One sentence for both phases, because the operator's move is the same either
 * way: raise `SPECGUARD_TIMEOUT_MS` or find out why the deployment is slow.
 *
 * Deliberately an `ApiError` and deliberately WITHOUT a status. Letting an
 * `AbortError` escape instead would reach `describeError` in `server.ts` as a
 * non-`SpecGuardMcpError` and be reported to the agent as "a bug in the bridge,
 * not in your project or configuration" — exactly inverting the diagnosis for a
 * peer that stalled. And there was no response, so there is no status to carry.
 */
function timedOut(api: ApiConfig): ApiError {
  return new ApiError(`${api.endpoint} did not respond within ${api.requestTimeoutMs}ms.`);
}

/**
 * The status turned into something the agent can act on.
 *
 * 401 is called out by name because it is the one an operator will actually
 * hit, and because SpecGuard answers it deliberately flat — "a valid Bearer API
 * key is required", with no detail about why — so the useful half of the
 * diagnosis has to be supplied from this side.
 *
 * WHICH VARIABLE AND WHICH PREFIX ARE READ OFF `api.credential`, never spelled
 * out here. SpecGuard has two credential kinds that refuse each other's tokens
 * before any table is read, so this one branch is reached by tools reading two
 * different variables — and the sentence it used to hardcode ("SPECGUARD_API_KEY
 * must be an sgk_… key … keys are per-repository") is false in all three of its
 * claims for a user-scoped tool, naming a variable its operator may never have
 * touched. That is the same defect `endpointVariable` fixes one branch down, and
 * it gets the same remedy rather than a second hardcoded string: a tool added
 * later inherits correct naming from the `require*` helper it already calls.
 */
function describeFailure(status: number, body: string, api: ApiConfig): ApiError {
  if (status === 401) {
    const { variable, prefix, rejection } = api.credential;

    return new ApiError(
      `SpecGuard rejected the API key (401). ${variable} must be an ${prefix}… key issued by ` +
        `${api.endpoint} ${rejection}.`,
      status,
    );
  }

  if (status === 404) {
    return new ApiError(
      `${api.endpoint} has no such endpoint (404). Check that ${api.endpointVariable} is the ` +
        "deployment's root URL, without a path.",
      status,
    );
  }

  return new ApiError(
    `SpecGuard answered ${status}${body.trim() === "" ? "" : `: ${body.trim().slice(0, 500)}`}`,
    status,
  );
}

export { requireApiConfig, requireUserApiConfig };
