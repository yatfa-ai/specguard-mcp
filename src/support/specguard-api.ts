import {
  requireAgentApiConfig,
  requireApiConfig,
  requireEndpointApiConfig,
  requireUserApiConfig,
  requireUserOrAgentApiConfig,
  type ApiConfig,
  type Config,
  type CredentialledApiConfig,
} from "../config.js";
import { ApiError } from "../errors.js";

/**
 * The SpecGuard HTTP client — a Bearer key and a path, and nothing else.
 *
 * Authorization is enforced by the deployment (`Api::BaseController`), never
 * here: this carries the operator's key and reports what came back. The bridge
 * adds no credentials of its own and makes no access decisions, so there is no
 * second place for the permission model to be got wrong.
 *
 * The key is PRESENT-CONDITIONAL since SPGD-1200: every credentialled helper
 * binds one and it rides every request as before, while a credential-free ask
 * (`requireEndpointApiConfig`, the unauthenticated `/version`) presents NO
 * `Authorization` header at all rather than `Bearer ` with nothing after it.
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
 * `PATCH` with a JSON body — the mutating-without-replacing half of the
 * transport, and deliberately the SAME function underneath `postJson`, for the
 * reason that header states: everything expensive about this module is about
 * the deadline, not the verb.
 *
 * Routed through `requestJson` rather than `deleteJson`'s raw-body handling,
 * because every PATCH this surface serves answers `200` WITH a JSON body —
 * `requestJson`'s parse is correct here, and re-deriving success handling would
 * be a third copy of the one status check.
 */
export async function patchJson(
  api: ApiConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  return requestJson(new URL(`${api.endpoint}${path}`), api, fetchImpl, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * `DELETE` — the destructive half of the transport, and deliberately the SAME
 * function underneath `postJson` rather than beside it, for the reason
 * `postJson`'s header states: everything expensive about this module is about
 * the deadline, not the verb.
 *
 * Returns the RAW BODY TEXT rather than a parsed value, because the endpoints
 * this serves answer `204` with NO body at all — the one response in the `sgu_`
 * surface that is deliberately not JSON. `requestJson` JSON-parses every 2xx it
 * sees, so routing a `204` through it would turn a successful delete into
 * "answered 204 but the body was not JSON" — the trap this verb specifically
 * introduces, and the reason the DELETE path has its own success handling
 * instead of sharing `requestJson`'s. The status check and the
 * "reached and refused" hand-off to `describeFailure` are still shared
 * verbatim: only what happens to a SUCCESS body differs.
 */
export async function deleteJson(
  api: ApiConfig,
  path: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const { response, body } = await fetchWithTimeout(
    new URL(`${api.endpoint}${path}`),
    api,
    fetchImpl,
    { method: "DELETE" },
  );

  if (!response.ok) throw describeFailure(response.status, body, api);

  return body;
}

/**
 * `DELETE` that answers with a JSON body — the destructive verb's one non-empty
 * answer, routed through `requestJson` rather than `deleteJson`'s raw-body
 * handling.
 *
 * Every DELETE this surface served until now answered `204` with NO body — the
 * reason `deleteJson` exists and returns raw text. The agent-key revoke
 * (`DELETE /api/v1/repositories/:repository_id/agent_keys/:id`) answers `200`
 * WITH a JSON disclosure body: the platform's substitute for the confirm dialog
 * the web face shows, naming the full stored set the cut just landed on. The
 * body is the point of the response, so this verb parses it — and re-deriving
 * the status check and the not-JSON diagnosis here would be a third copy of the
 * one check `requestJson` owns, which is exactly the argument `patchJson`'s
 * header makes for its own 200-with-body case. `deleteJson` stays exported and
 * byte-unchanged for the endpoints that legitimately answer empty.
 */
export async function deleteJsonObject(
  api: ApiConfig,
  path: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  return asJsonObject(
    await requestJson(new URL(`${api.endpoint}${path}`), api, fetchImpl, { method: "DELETE" }),
  );
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
 * `patchJson`, narrowed exactly as `postJsonObject` narrows `postJson` — same
 * guard, same sentence, same reason: `ToolResult.structured` is a
 * `Record<string, unknown>`, so no tool should re-type the three-clause check
 * on this verb either.
 */
export async function patchJsonObject(
  api: ApiConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  return asJsonObject(await patchJson(api, path, body, fetchImpl));
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
 * This bridge's wire identity, resolved at REQUEST time.
 *
 * `server.ts` owns `SERVER_VERSION` (manifest-derived since SPGD-1190) and this
 * transport needs it on every request — but a STATIC import would close the
 * graph's existing cycle the one way it cannot survive: `server.ts` imports the
 * tool registry, the tools import this transport, and the edge back would make
 * `tools/index.js` evaluate while whichever tool module started the load is
 * still mid-evaluation. `tools/index.js` builds its registry in its own module
 * body, dereferencing those in-flight tool bindings before they are
 * initialized — a TDZ ReferenceError at boot (`Cannot access 'addRepository'
 * before initialization`), hit the moment this import went static, in every
 * load order that enters through a tool module rather than through
 * `server.ts`. A lazy READ of the constant is not enough; the LOAD itself has
 * to wait until a request.
 *
 * Loading at request time is safe in every order: by the time any request can
 * run, the whole module graph has finished evaluating, so `import()` is a
 * module-cache hit that hands back the already-initialized export. The promise
 * is memoized — and the `import()` call kept inside this function, never at
 * module scope, where it would start the same evaluation re-entry at load
 * time. The per-request cost is one awaited, already-resolved promise.
 */
let serverIdentity: Promise<typeof import("../server.js")> | undefined;

async function requestUserAgent(): Promise<string> {
  serverIdentity ??= import("../server.js");
  const { SERVER_VERSION } = await serverIdentity;
  return `specguard-mcp/${SERVER_VERSION}`;
}

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
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
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

  // Assembled BEFORE the deadline is armed: the deadline bounds the network
  // call, not our own header assembly (which is a module-cache hit in every
  // real order — see `requestUserAgent`).
  const userAgent = await requestUserAgent();

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
          Accept: "application/json",
          // The version rides the identity the platform's rejection triage
          // stores verbatim (`specguard-mcp/<version>`), the same shape the
          // sibling clients already send. Resolved per request — see
          // `requestUserAgent` for why the load, not just the read, is lazy.
          "User-Agent": userAgent,
          // Sent only when there IS a key. The credential-free ask (SPGD-1200,
          // `requireEndpointApiConfig`) presents nothing rather than `Bearer `
          // with nothing after it — precisely the present-but-empty value
          // `presence()` refuses on the way in, because a header announcing a
          // key that is not there is a malformed request waiting for a proxy
          // to notice. This is `Content-Type`'s conditional-header pattern,
          // one key below, for the mirrored reason.
          ...(api.apiKey === undefined ? {} : { Authorization: `Bearer ${api.apiKey}` }),
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
 * hit. SpecGuard's 401 body is a contract — `{error: "unauthorized"}` plus a
 * `message` — in which `reason` appears on exactly one fork: a token whose
 * digest resolves a REVOKED key answers `reason: "revoked"` with a message
 * naming the remedy. The backend licenses that disclosure precisely because
 * only someone presenting the exact token can land on the branch, so where the
 * body carries it, this one stops discarding the body and hands the platform's
 * sentence through (`revokedCredentialMessage` below) — the same
 * surfacing-not-reshaping doctrine `refusalMessage` follows for 400/403. In
 * EVERY other case — `reason` absent, a blank or non-string `message`, a body
 * that does not parse — the generic body still names no cause at all, so the
 * useful half of the diagnosis is supplied from this side and the key keeps
 * reading as an unknown key.
 *
 * WHICH VARIABLE AND WHICH PREFIX ARE READ OFF `api.credential`, never spelled
 * out here. SpecGuard has three credential kinds that refuse each other's
 * tokens before any table is read, so this one branch is reached by tools
 * reading three different variables — and the sentence it used to hardcode
 * ("SPECGUARD_API_KEY must be an sgk_… key … keys are per-repository") is false
 * in all three of its claims for a user- or agent-scoped tool, naming a
 * variable its operator may never have touched. That is the same defect
 * `endpointVariable` fixes one branch down, and it gets the same remedy rather
 * than a second hardcoded string: a tool added later inherits correct naming
 * from the `require*` helper it already calls.
 *
 * The canned sentence is CREDENTIAL-CONDITIONAL since SPGD-1200: a
 * credential-free ask cannot have a KEY problem — it presented no key, and the
 * endpoint it reads (`/version`) never authenticates — so sentencing it to a
 * `must be an … key` lecture would name a variable its operator never needed
 * to set. With no credential bound the branch falls through to the generic
 * sentence below, which shows what actually came back. The revoked-key arm
 * above stays unconditional on purpose: it is keyed on the BODY the platform
 * served, not on what this side sent, and surfacing the platform's own
 * sentence is never the wrong answer.
 */
function describeFailure(status: number, body: string, api: ApiConfig): ApiError {
  if (status === 401) {
    // The one 401 whose cause the platform names itself. Everything else —
    // including an unparseable body — must keep reading as an unknown key, so
    // the fallback below stays byte-identical to what it has always been.
    const revoked = revokedCredentialMessage(body);
    if (revoked !== undefined) return new ApiError(revoked, status);

    // A credential-free ask falls through to the generic sentence — see the
    // header above. This branch only speaks when there is a credential whose
    // variable and prefix a sentence about a key can truthfully name.
    if (api.credential !== undefined) {
      const { variable, prefix, rejection } = api.credential;

      return new ApiError(
        `SpecGuard rejected the API key (401). ${variable} must be an ${prefix}… key issued by ` +
          `${api.endpoint} ${rejection}.`,
        status,
      );
    }
  }

  if (status === 404) {
    // Order by certainty: a body that names its own cause beats the heuristic.
    // The platform's own `render_not_found` body is an in-contract answer with
    // a named cause — most commonly a stale or wrong key id on the
    // rotation/orphan-recovery arc (`repository.api_keys.find_by` raising into
    // it with "No API key with that id belongs to this repository.") — so it
    // is surfaced verbatim FIRST, exactly as the 401 branch does
    // for `reason: "revoked"`. Every body that is not that shape still answers
    // the canned endpoint hint below, because for a 404 whose body is a
    // proxy's HTML (or nothing at all) endpoint misconfiguration remains the
    // likeliest cause and the hint is the right diagnosis for it.
    const notFound = notFoundMessage(body);
    if (notFound !== undefined) return new ApiError(notFound, status);

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

/**
 * The one 401 whose cause SpecGuard names itself, or nothing.
 *
 * `Api::BaseController` forks a single arm off the generic 401: a Bearer token
 * whose digest resolves a REVOKED key renders
 * `{error: "unauthorized", reason: "revoked", message: …}`. The backend
 * licenses that disclosure because only someone presenting the exact token can
 * reach the branch — the lookup runs on the digest they carried — and the
 * message names the remedy: mint a replacement and update whatever presents
 * this one. That is the OPPOSITE move from what the canned sentence in
 * `describeFailure` prescribes (re-check which variable holds which kind of
 * key), which is why flattening this arm back into that sentence sends a
 * revoked-key operator to configuration when the actual fix is rotation.
 *
 * SURFACING IT IS THE OPPOSITE OF RESHAPING IT, the same doctrine
 * `refusalMessage` states one branch over: the platform's message is a
 * complete, operator-ready sentence, so it is handed through verbatim — no
 * prefix, no framing; only a whitespace-only `message` counts as absent. The
 * 401 status still rides the `ApiError`, so nothing downstream loses it.
 *
 * The discriminator is the `reason` FIELD, never the presence of a `message`:
 * the generic 401 body carries a message too and carries NO `reason`, and the
 * backend pins that an unknown token must keep reading as an unknown token —
 * the canned sentence stays the contract for everything that is not this
 * disclosure. Returns `undefined` rather than a fallback for the same reason
 * `refusalMessage` does, so the decision about what to say stays in one place:
 * a body that does not parse, is not an object, carries any other `reason`, or
 * whose `message` is absent, blank or not a string falls back to the canned
 * sentence rather than to a thrown parse error or an invented reading.
 */
function revokedCredentialMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  if (record["reason"] !== "revoked") return undefined;

  const message = record["message"];
  if (typeof message !== "string" || message.trim() === "") return undefined;

  return message;
}

/**
 * The 404 whose cause SpecGuard names itself, or nothing.
 *
 * `Api::BaseController` rescues `ActiveRecord::RecordNotFound` into
 * `render_not_found`, which renders `{error: "not_found", message:}` at 404 —
 * and the messages it carries are complete operator guidance ("No repository
 * with that id is available to this key."). On the endpoints this bridge
 * wraps, the most common of those is a stale or wrong key id on the
 * rotation/orphan-recovery arc the revoke tool itself prescribes (mint
 * replacement → deploy → revoke orphan), which reaches here through
 * `repository.api_keys.find_by` and its explicit raise:
 * "No API key with that id belongs to this repository."
 * Answering the canned endpoint hint to that body
 * sends the reader to debug `SPECGUARD_ENDPOINT` when the actual fix is
 * re-checking WHICH key it named — a fault-assigning message recruiting the
 * reader toward the wrong remedy, the same defect class the 401 branch's
 * wrong-kind sentence was.
 *
 * SURFACING IT IS THE OPPOSITE OF RESHAPING IT, the revoked-credential
 * doctrine verbatim: the platform's sentence is handed through with no
 * prefix and no framing, because it is already complete. The 404 status still
 * rides the `ApiError`.
 *
 * The discriminator is the `error` FIELD, never the presence of a `message` —
 * the same field-keyed doctrine the 401 arm applies to `reason: "revoked"`:
 * a 404 from anything that is not this contract (a proxy's HTML, an empty
 * body, JSON with some other `error`) still names no cause at all, so the
 * canned endpoint-hint sentence stays the contract for everything that is not
 * this disclosure. Returns `undefined` rather than a fallback for the same
 * reason its two siblings do, so the decision about what to say stays in one
 * place: a body that does not parse, is not an object, carries any other
 * `error`, or whose `message` is absent, blank or not a string falls back to
 * the canned sentence rather than to a thrown parse error or an invented
 * reading.
 */
function notFoundMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  if (record["error"] !== "not_found") return undefined;

  const message = record["message"];
  if (typeof message !== "string" || message.trim() === "") return undefined;

  return message;
}

/**
 * The (credential, path) pair ONE repository ask must travel as — both arms
 * of the singular/plural branch, chosen together or not at all.
 *
 * A tool asks either the whole deployment — the `sgk_` slot
 * (`SPECGUARD_API_KEY`) against the singular `/api/v1/repository` — or one
 * repository inside it — either member credential (the agent key preferred,
 * the user key when no agent key is set; the SPGD-1106 widening; the route
 * has served both since SPGD-952) against the plural
 * `/api/v1/repositories/…`. The pair (path, credential) must not be mixable:
 * a plural path under the `sgk_` slot, or a singular path under a member
 * key, is a 401 at the deployment by design, and both mistakes are refused
 * HERE, legibly, instead of reaching the deployment. Holding the two
 * ternaries in one function is what keeps the two arms one branch point
 * rather than two lines a call site can re-pair — the module header's "no
 * second place for the permission model to be got wrong", applied to the
 * one branch that used to be carried as a copy in each of the two tools
 * that ask over this axis.
 *
 * Both such tools call it — `near-duplicate-clusters.ts` and
 * `repository-overview.ts` — and a tool that grows a `repository` argument
 * joins by calling this, not by re-spelling the branch. Blank-string and
 * `optionalString` handling stays in the tools: this decides transport and
 * credential from the ask exactly as handed to it, `undefined` being the
 * one spelling of "no ask".
 */
export function repositoryTarget(
  config: Config,
  repository: string | undefined,
): { api: CredentialledApiConfig; path: string } {
  const api =
    repository === undefined
      ? requireApiConfig(config)
      : requireUserOrAgentApiConfig(config);
  const path =
    repository === undefined
      ? "/api/v1/repository"
      : `/api/v1/repositories/${encodeURIComponent(repository)}`;
  return { api, path };
}

export {
  requireApiConfig,
  requireUserApiConfig,
  requireAgentApiConfig,
  requireUserOrAgentApiConfig,
  requireEndpointApiConfig,
};
