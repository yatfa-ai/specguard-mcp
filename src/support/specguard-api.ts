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

  return requestJson(url, api, fetchImpl, { method: "GET" });
}

/**
 * `POST` with a JSON body — the write half of the transport, and deliberately
 * the SAME function underneath.
 *
 * It shares `fetchWithTimeout` rather than standing beside it. The one-total-
 * budget deadline, the explicit race, the `unref`'d timer, the abort and the
 * "reached and stopped" vs "could not reach" split are the expensive part of
 * this module and every argument for them is written above them — none of it is
 * about the verb. A second transport re-deriving them is how the two come to
 * disagree about what `SPECGUARD_TIMEOUT_MS` bounds, and the write path is the
 * one where a call that never returns costs the most: the agent has already
 * committed to a registration by the time it hangs.
 *
 * The body is serialized HERE rather than taken as a string, so no caller can
 * send a body whose `Content-Type` says JSON and whose bytes are not.
 */
export async function postJson(
  api: ApiConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  return requestJson(new URL(`${api.endpoint}${path}`), api, fetchImpl, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * `postJson`, narrowed exactly as `getJsonObject` narrows `getJson`.
 *
 * The write path needs the same guard for the same reason, and the reason is not
 * about reading: `ToolResult.structured` is a `Record<string, unknown>`, so a
 * body that is an array or a bare scalar is not something a tool can pass
 * through whichever verb fetched it. Shipping only the raw `postJson` would
 * leave the first write tool to re-type the three-clause check and its sentence
 * — which is precisely the duplication `getJsonObject`'s header says no tool
 * should have to repeat.
 *
 * The pair is mirrored rather than collapsed for the reason the read pair is:
 * `postJson` stays exported un-narrowed for an endpoint that legitimately
 * answers with an array.
 */
export async function postJsonObject(
  api: ApiConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  return asJsonObject(await postJson(api, path, body, fetchImpl));
}

/**
 * Everything both verbs do with a response, in one place.
 *
 * Extracted when the write path landed rather than copied into it: the status
 * check, the "reached and refused" hand-off to `describeFailure` and the
 * not-JSON sentence are identical for a `GET` and a `POST`, and the not-JSON
 * sentence in particular is a diagnosis an operator acts on — a second copy is a
 * second wording waiting to drift from this one.
 */
async function requestJson(
  url: URL,
  api: ApiConfig,
  fetchImpl: typeof globalThis.fetch,
  request: RequestSpec,
): Promise<unknown> {
  const { response, body } = await fetchWithTimeout(url, api, fetchImpl, request);

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

/** The three-clause guard both `*JsonObject` narrowings share. */
function asJsonObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError("SpecGuard returned a JSON value that was not an object.");
  }

  return body as Record<string, unknown>;
}

/**
 * `getJson`, narrowed to the object every tool here actually asks it for.
 *
 * MCP hands a tool result back as an object, so an array or a bare JSON scalar
 * is not something a tool can pass through: it surfaces as a protocol error
 * rather than as something the agent can read. Every HTTP tool therefore
 * needed the same three-clause guard, and the same sentence, immediately after
 * its own `getJson` call — which made both the check and its wording the one
 * thing each new tool had to remember to write for itself, and get identical.
 *
 * It belongs here for the reason `requireApiConfig` parses the endpoint rather
 * than leaving that to callers: every HTTP-backed tool added later comes
 * through this function and inherits the check, the same way it inherits the
 * URL check and the 401 wording. `getJson` stays exported un-narrowed for an
 * endpoint that legitimately serves an array — the point is not that objects
 * are the only legal body, it is that no tool re-types this guard.
 */
export async function getJsonObject(
  api: ApiConfig,
  path: string,
  query: Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  return asJsonObject(await getJson(api, path, query, fetchImpl));
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
 * The verb and body of one call — what differs between a read and a write, and
 * the whole of what differs.
 *
 * Deliberately narrow: everything else about a request (the deadline, the
 * credential, the `Accept` and `User-Agent` headers, the abort) is a property of
 * this transport rather than of an individual call, and stays where it is
 * argued for rather than becoming something each caller can vary.
 */
interface RequestSpec {
  readonly method: "GET" | "POST";
  readonly body?: string;
}

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
  request: RequestSpec,
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
        method: request.method,
        headers: {
          Authorization: `Bearer ${api.apiKey}`,
          Accept: "application/json",
          "User-Agent": "specguard-mcp",
          // Sent only when there IS a body. A `Content-Type` on a GET announces
          // a payload that is not there, and some deployments and proxies treat
          // that as a malformed request rather than as a harmless header.
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
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

  if (status === 400 || status === 403) {
    const message = refusalMessage(body, status);
    if (message !== undefined) return new ApiError(message, status);
  }

  return new ApiError(
    `SpecGuard answered ${status}${body.trim() === "" ? "" : `: ${body.trim().slice(0, 500)}`}`,
    status,
  );
}

/**
 * The sentence SpecGuard already wrote, or nothing.
 *
 * `Api::BaseController#render_bad_request` is a CONTRACT, not an ad-hoc body:
 * `{error:, message:, details:}`, where `details` carries every validation
 * failure and `message` repeats the first "so a client that reads only the two
 * conventional keys still learns which spec is at fault". Both callers of it on
 * `origin/main` route here, so this branch serves the API surface rather than
 * one tool.
 *
 * The 403 is the same shape under another status. `UserRepositoriesController#
 * render_not_granted` renders `{error: "not_granted", message:, grant:}` — the
 * `grant` block is simply ignored by the extractor, exactly as `details` is.
 * Same defect (the generic branch truncating the one sentence that names the
 * fix), same remedy — which is why the helper is ONE function parameterised on
 * the status rather than two copies beside each other.
 *
 * SURFACING IT IS THE OPPOSITE OF RESHAPING IT. The generic branch below turns
 * the most useful sentence in this direction —
 *
 *   "cannot be registered from an API key — SpecGuard has no current record of
 *    your GitHub permissions. Sign in to SpecGuard in a browser and reconnect
 *    GitHub, then try again."
 *
 * — into a JSON blob glued to "SpecGuard answered 400" and truncated at 500
 * characters. That sentence names the operator's exact next move, and it is the
 * MODAL first answer this endpoint gives: `GrantVerifier` fails closed on a
 * missing or stale grant, which is every person who has not opened SpecGuard in
 * a browser since the feature shipped. `:not_administered`, `:not_in_installation`
 * and "has already been taken" arrive the same way. This branch does not author
 * a sentence the way the 401 and 404 branches must — it stops DISCARDING one.
 *
 * Returns `undefined` rather than a fallback string, so the decision about what
 * to say when the body is not that shape stays in one place. A 400 from
 * somewhere that is not this contract — a proxy's HTML, a bare string, JSON
 * whose `message` is absent or is not a string — still gets the generic
 * sentence, which at least shows the operator what actually came back.
 */
function refusalMessage(body: string, status: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const message = (parsed as Record<string, unknown>)["message"];
  if (typeof message !== "string" || message.trim() === "") return undefined;

  return `SpecGuard refused the request (${status}): ${message.trim()}`;
}

export { requireApiConfig, requireUserApiConfig };
