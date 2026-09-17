import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { ApiError, SpecGuardMcpError } from "../../src/errors.js";
import { SERVER_VERSION } from "../../src/server.js";
import {
  deleteJson,
  getJson,
  getJsonObject,
  postJson,
  postJsonObject,
  repositoryTarget,
  requireApiConfig,
  requireEndpointApiConfig,
} from "../../src/support/specguard-api.js";
import { rejects, stubFetch, stubSlowFetch } from "./stubs.js";

/**
 * A 50ms budget, expressed the way an operator expresses it.
 *
 * Built through `loadConfig` rather than by hand-rolling an `ApiConfig` literal,
 * so the number under test is the one `SPECGUARD_TIMEOUT_MS` actually produces —
 * a test that constructed the object directly would stay green if the env
 * variable stopped reaching `requestTimeoutMs` at all. Small on purpose: these
 * assertions resolve when the deadline fires, so the deadline has to be short.
 */
function api(timeoutMs: string) {
  return requireApiConfig(
    loadConfig({
      SPECGUARD_ENDPOINT: "https://sg.example.com",
      SPECGUARD_API_KEY: "sgk_test",
      SPECGUARD_TIMEOUT_MS: timeoutMs,
    }),
  );
}

/** Headers that never arrive either, from an implementation that ignores the signal. */
const neverAnswers = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;

/**
 * The deadline covers the WHOLE call, not just its headers.
 *
 * Every test here carries an explicit `timeout`, because the regression this
 * file locks is a hang. Without one, reverting the source change would leave
 * `npm test` running forever instead of failing — and a suite that never
 * finishes reports nothing at all, least of all which guard caught the defect.
 */
describe("getJson — one deadline across headers and body", () => {
  /**
   * Stands in for the socket a real call would have open.
   *
   * The deadline timer is `unref`'d on purpose, so a stalled read cannot by
   * itself hold the server's process open. In production that costs nothing:
   * the in-flight connection keeps the event loop alive, so the timer still
   * fires. A stub has no connection, and with every timer here unref'd Node
   * drains the loop while the assertion is still awaiting — the test runner then
   * cancels the test ("Promise resolution is still pending but the event loop
   * has already resolved") instead of letting the deadline fire at all. This
   * ref'd interval supplies the one thing the stub cannot, and is cleared with
   * the test so it cannot leak into the next file.
   */
  let socket: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    socket = setInterval(() => {}, 1_000);
  });

  afterEach(() => {
    clearInterval(socket);
  });

  it("rejects when the body stalls after the headers arrive", { timeout: 5_000 }, async () => {
    // Headers at once, body never. Bounding only the fetch call leaves this
    // pending forever: `text()` is awaited with the timer already cleared.
    const http = stubSlowFetch("never");

    const error = await rejects(
      getJson(api("50"), "/api/v1/repository", {}, http.fetch),
      /https:\/\/sg\.example\.com did not respond within 50ms/,
    );

    // The abort must arrive as the timeout it is. A raw `AbortError` from
    // `text()` is not a `SpecGuardMcpError`, so `describeError` in `server.ts`
    // would report a stalled deployment as "a bug in the bridge, not in your
    // project or configuration" — sending the agent to fix the one thing that is
    // not wrong.
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${error.name}`);
    assert.ok(error instanceof SpecGuardMcpError);

    // There was no completed response, so there is no status to claim one.
    assert.equal((error as ApiError).status, undefined);

    // And the headers phase did happen — this is the body being bounded, not the
    // request being refused before it was ever made.
    assert.equal(http.requests.length, 1);
  });

  it("bounds the headers phase too, whatever the implementation does with the signal", { timeout: 5_000 }, async () => {
    // The headers phase was nominally bounded before — but only for a `fetch`
    // that honours `signal` and rejects when it is aborted. Racing the deadline
    // rather than delegating to the abort makes the bound hold for the one this
    // module is actually handed, which is a parameter.
    await rejects(
      getJson(api("50"), "/api/v1/repository", {}, neverAnswers),
      /https:\/\/sg\.example\.com did not respond within 50ms/,
    );
  });

  it("does not describe a stall as an unreachable deployment", { timeout: 5_000 }, async () => {
    // The two branches diagnose different problems and send an operator to
    // different places. A body-read abort surfacing as "Could not reach" would
    // name a cause that is the opposite of the truth: the deployment was
    // reached, and then stopped.
    const error = await rejects(
      getJson(api("50"), "/api/v1/repository", {}, stubSlowFetch("never").fetch),
      /did not respond within/,
    );

    assert.doesNotMatch(error.message, /Could not reach/);
  });

  it("lets a slow-but-inside-the-budget body through untouched", { timeout: 5_000 }, async () => {
    // The other half of the claim, and the half that keeps the first from being
    // satisfiable by a client that simply refuses every streamed body: a body
    // that arrives late — but before the deadline — is still parsed and returned.
    const http = stubSlowFetch(10, { body: JSON.stringify({ repository: { name: "app" } }) });

    const body = await getJson(api("2000"), "/api/v1/repository", {}, http.fetch);

    assert.deepEqual(body, { repository: { name: "app" } });
  });

  it("reads a streamed non-2xx body before diagnosing the status", { timeout: 5_000 }, async () => {
    // The failure path reads the same body the success path does, so it has to
    // survive the same split into two phases. `describeFailure` echoes the body
    // back, and it can only do that if the deadline let the read finish.
    await rejects(
      getJson(api("2000"), "/api/v1/repository", {}, stubSlowFetch(10, { status: 503, body: "upstream down" }).fetch),
      /503.*upstream down/s,
    );
  });
});

/**
 * The not-an-object guard belongs to the TRANSPORT, not to each tool that uses it.
 *
 * MCP hands a tool result back as an object, so a body that is an array or a
 * bare scalar cannot be passed through — it surfaces as a protocol error rather
 * than as something the agent can read. Every HTTP tool therefore needs this
 * check, which is exactly why it must not live in any of them: it was written
 * out twice, verbatim down to the sentence, before it moved here, and the third
 * copy would have been the one that drifted.
 *
 * Asserted on `getJsonObject` itself rather than only through a tool, for the
 * reason `requireApiConfig` is tested directly: a tool-level test proves the
 * guard fires for THAT tool, and a tool added later inherits the function
 * whether or not anyone writes a matching test for it. This is what that
 * inheritance is worth.
 */
describe("getJsonObject — the object narrowing every HTTP tool inherits", () => {
  const config = api("2000");

  it("returns the object unchanged when the body is one", async () => {
    // The guard must not be satisfiable by a function that rejects everything:
    // a legitimate object is passed through untouched, not copied or reshaped.
    const body = { repositories: [{ id: 1, full_name: "acme/app" }] };

    const result = await getJsonObject(
      config,
      "/api/v1/repositories",
      {},
      stubFetch({ body: JSON.stringify(body) }).fetch,
    );

    assert.deepEqual(result, body);
  });

  // The three shapes `typeof body === "object"` alone would not settle. An array
  // and `null` are BOTH typeof "object" in JavaScript, which is the whole reason
  // the check has three clauses rather than one — drop either clause and the
  // corresponding case below is the one that stops failing.
  for (const [shape, body] of [
    ["an array", "[]"],
    ["null", "null"],
    ["a bare scalar", "42"],
  ] as const) {
    it(`refuses ${shape}`, async () => {
      await rejects(
        getJsonObject(config, "/api/v1/repositories", {}, stubFetch({ body }).fetch),
        /not an object/,
      );
    });
  }

  it("leaves getJson itself un-narrowed, so an array body stays reachable", async () => {
    // Deliberately NOT the same function. An endpoint that legitimately serves a
    // top-level array is a thing SpecGuard may add, and the raw transport must
    // still be able to carry it — the rule is that no tool re-types the guard,
    // not that objects are the only legal body.
    const body = await getJson(config, "/api/v1/repositories", {}, stubFetch({ body: "[]" }).fetch);

    assert.deepEqual(body, []);
  });
});

/**
 * THE WRITE PATH — and the first thing in this repo that could send a request
 * body at all.
 *
 * `getJson` hardcoded `method: "GET"` and took none, which is why the registry
 * carried a standing reservation against wrapping `POST /api/v1/repositories`
 * even though that endpoint had shipped. What is under test here is the
 * transport half of lifting it.
 *
 * Asserted at THIS level rather than only through `add_repository`, for the
 * reason the `getJsonObject` block states one above: a tool-level test proves
 * the wire shape for THAT tool, and the next write tool inherits this function
 * whether or not anyone writes a matching test for it.
 */
describe("postJson — the write transport", () => {
  const config = api("2000");

  it("sends a POST, and the body it was given, to the URL it was given", async () => {
    // The whole request, because a check on the URL alone is satisfied exactly
    // as well by a GET that sends nothing. `stubs.ts` records the method and
    // body precisely so this assertion can exist.
    const http = stubFetch({ status: 201, body: "{}" });

    await postJson(config, "/api/v1/repositories", { github_full_name: "acme/app" }, http.fetch);

    const request = http.requests[0];
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories");
    assert.equal(request?.body, '{"github_full_name":"acme/app"}');
  });

  it("carries the credential and announces the body as JSON", async () => {
    const http = stubFetch({ status: 201, body: "{}" });

    await postJson(config, "/api/v1/repositories", { github_full_name: "acme/app" }, http.fetch);

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
    assert.equal(http.requests[0]?.headers["content-type"], "application/json");
  });

  it("leaves the read path a bodiless GET, with no Content-Type it does not need", async () => {
    // The other half of threading a method through one shared transport: the
    // verb became a parameter, so the GET's own shape has to be pinned or a
    // default that drifted would go unnoticed. A `Content-Type` on a request
    // with no body announces a payload that is not there.
    const http = stubFetch({ body: "{}" });

    await getJson(config, "/api/v1/repository", {}, http.fetch);

    assert.equal(http.requests[0]?.method, "GET");
    assert.equal(http.requests[0]?.body, undefined);
    assert.equal(http.requests[0]?.headers["content-type"], undefined);
  });

  it("returns the parsed body of a 201", async () => {
    const body = { repository: { full_name: "acme/app" }, api_key: { token: "sgk_live" } };

    const parsed = await postJson(
      config,
      "/api/v1/repositories",
      { github_full_name: "acme/app" },
      stubFetch({ status: 201, body: JSON.stringify(body) }).fetch,
    );

    assert.deepEqual(parsed, body);
  });

  it("narrows to an object through postJsonObject, exactly as the read pair does", async () => {
    // The write path needs the same guard for the same reason — `structured` is
    // a `Record<string, unknown>`, whichever verb fetched it — and mirroring the
    // pair is what keeps the next write tool from re-typing the check.
    await rejects(
      postJsonObject(config, "/api/v1/repositories", {}, stubFetch({ status: 201, body: "[]" }).fetch),
      /not an object/,
    );

    const body = await postJson(
      config,
      "/api/v1/repositories",
      {},
      stubFetch({ status: 201, body: "[]" }).fetch,
    );
    assert.deepEqual(body, [], "postJson itself must stay un-narrowed, like getJson");
  });
});

/**
 * The User-Agent is the one header the PLATFORM reads: the ingest-rejection
 * path stores it verbatim as the row's `user_agent`/`reported_client`, and both
 * sibling clients already send `product/version` UAs to these same endpoints.
 * A bare `specguard-mcp` leaves every bridge-originated rejection row triage-
 * blind to which delivery produced it — which is why the header is pinned here
 * at the transport, on both a read and a write, rather than only through a
 * tool-level test or the serverInfo handshake.
 *
 * The expected value is BUILT from the `SERVER_VERSION` constant the transport
 * itself imports — never a literal — so a manifest bump cannot rot the pin,
 * and a hardcoded identity in either place fails this immediately.
 */
describe("User-Agent — the version the client claims", () => {
  const config = api("2000");

  it("sends specguard-mcp/<SERVER_VERSION> on a GET", async () => {
    const http = stubFetch({ body: "{}" });

    await getJson(config, "/api/v1/repository", {}, http.fetch);

    assert.equal(http.requests[0]?.headers["user-agent"], `specguard-mcp/${SERVER_VERSION}`);
  });

  it("sends specguard-mcp/<SERVER_VERSION> on a write", async () => {
    const http = stubFetch({ status: 201, body: "{}" });

    await postJson(config, "/api/v1/repositories", { github_full_name: "acme/app" }, http.fetch);

    assert.equal(http.requests[0]?.headers["user-agent"], `specguard-mcp/${SERVER_VERSION}`);
  });
});

/**
 * THE CREDENTIAL-FREE ASK, at the transport (SPGD-1200).
 *
 * `ApiConfig`'s key and credential are optional now, and this block pins what
 * that optionality MEANS on the wire — in both directions. A credential-free
 * ask (`requireEndpointApiConfig`, wrapping the unauthenticated `/version`)
 * must present NO `Authorization` header rather than a `Bearer ` with nothing
 * after it, and its 401 — unreachable from `/version` itself, but the
 * transport is shared — must fall to the generic sentence rather than a key
 * lecture naming a variable nobody set. The credentialled path must be
 * byte-unchanged, because "the header became conditional" is a regression if
 * the condition ever stopped being met.
 */
describe("a credential-free ApiConfig — the unauthenticated /version ask", () => {
  const config = requireEndpointApiConfig(loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com" }));

  /** Verbatim from `Api::BaseController::REVOKED_CREDENTIAL_MESSAGE`. */
  const REVOKED =
    "This API key has been revoked. Mint a replacement key and update whatever presents this one.";

  /** The body `render_unauthorized` renders with its defaults — a message, but no `reason`. */
  const GENERIC = JSON.stringify({
    error: "unauthorized",
    message: "A valid Bearer API key is required.",
  });

  it("sends no Authorization header — never `Bearer ` with nothing after it", async () => {
    const http = stubFetch({ body: "{}" });

    await getJson(config, "/version", {}, http.fetch);

    const headers = http.requests[0]?.headers ?? {};
    assert.ok(!("authorization" in headers), `got ${JSON.stringify(headers)}`);
  });

  it("keeps sending the key on the credentialled path — the conditional is not a removal", async () => {
    // Guarding the other direction: widening `ApiConfig` must not have
    // unbound the key every credentialled helper returns. One read through a
    // credentialled config proves the header survives on the path the other
    // eighteen tools ride.
    const credentialled = requireApiConfig(
      loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" }),
    );
    const http = stubFetch({ body: "{}" });

    await getJson(credentialled, "/api/v1/repository", {}, http.fetch);

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sgk_test");
  });

  it("falls to the generic 401 sentence, never a key lecture, when no credential is bound", async () => {
    // A credential-free ask cannot have a KEY problem — it presented none —
    // so the canned sentence, which diagnoses a wrong-kind key by naming its
    // variable, would name a variable this ask never needed. The generic
    // sentence shows what actually came back instead.
    const error = await rejects(
      getJson(config, "/version", {}, stubFetch({ status: 401, body: GENERIC }).fetch),
      /SpecGuard answered 401/,
    );

    assert.doesNotMatch(error.message, /must be an sgk_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY/);
    assert.equal((error as ApiError).status, 401);
  });

  it("still surfaces the platform's revoked-credential sentence when the BODY carries it", async () => {
    // The revoked arm is keyed on the BODY the platform served, not on what
    // this side sent, so it stays unconditional: surfacing the platform's own
    // sentence is never the wrong answer, whoever the ask was from.
    const error = await rejects(
      getJson(
        config,
        "/version",
        {},
        stubFetch({
          status: 401,
          body: JSON.stringify({ error: "unauthorized", reason: "revoked", message: REVOKED }),
        }).fetch,
      ),
      /Mint a replacement key/,
    );

    assert.equal(error.message, REVOKED);
  });
});

/**
 * ONE DEADLINE ACROSS BOTH PHASES — on the write path too.
 *
 * Not assumed from the fact that `postJson` calls `fetchWithTimeout`: that IS
 * the claim, and a refactor that gave the write path its own fetch would satisfy
 * every other test in this file. The hang matters more here than on a read,
 * because a write that never returns leaves the agent holding a registration it
 * cannot confirm or repeat.
 *
 * Each test carries an explicit `timeout` for the reason the GET block states:
 * without one, reverting the source change leaves `npm test` running forever
 * instead of failing.
 */
describe("postJson — the same one deadline, headers and body", () => {
  let socket: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    socket = setInterval(() => {}, 1_000);
  });

  afterEach(() => {
    clearInterval(socket);
  });

  it("rejects when the body stalls after the headers arrive", { timeout: 5_000 }, async () => {
    const http = stubSlowFetch("never", { status: 201 });

    const error = await rejects(
      postJson(api("50"), "/api/v1/repositories", { github_full_name: "acme/app" }, http.fetch),
      /https:\/\/sg\.example\.com did not respond within 50ms/,
    );

    assert.ok(error instanceof ApiError, `expected an ApiError, got ${error.name}`);
    assert.ok(error instanceof SpecGuardMcpError);
    assert.equal((error as ApiError).status, undefined);

    // The request WAS made — this is the body being bounded, not the call being
    // refused before it was sent. Which for a write is the difference between
    // "nothing happened" and "something may have".
    assert.equal(http.requests.length, 1);
    assert.equal(http.requests[0]?.method, "POST");
  });

  it("bounds the headers phase too", { timeout: 5_000 }, async () => {
    await rejects(
      postJson(api("50"), "/api/v1/repositories", { github_full_name: "acme/app" }, neverAnswers),
      /https:\/\/sg\.example\.com did not respond within 50ms/,
    );
  });

  it("lets a slow-but-inside-the-budget body through untouched", { timeout: 5_000 }, async () => {
    // The half that keeps the two above from being satisfiable by a client that
    // refuses every streamed body.
    const body = await postJson(
      api("2000"),
      "/api/v1/repositories",
      { github_full_name: "acme/app" },
      stubSlowFetch(10, { status: 201, body: '{"repository":{"name":"app"}}' }).fetch,
    );

    assert.deepEqual(body, { repository: { name: "app" } });
  });
});

/**
 * THE 400 BRANCH — the server's own sentence, not a JSON blob.
 *
 * `Api::BaseController#render_bad_request` is a contract — `{error, message,
 * details}` — with two callers on `origin/main`, so this branch serves the API
 * surface rather than one tool. Through the generic branch the most useful
 * sentence in this direction arrived glued to "SpecGuard answered 400" and
 * truncated at 500 characters.
 *
 * Asserted in BOTH directions on purpose. A branch that surfaced `message`
 * whenever it could find one would be satisfied by the first test alone; what
 * has to hold is that a 400 which is NOT this contract still falls back to
 * showing the operator what actually came back, rather than to silence.
 */
describe("a 400 that carries SpecGuard's own refusal", () => {
  const config = api("2000");

  /** The modal first answer this endpoint gives, verbatim from `InstallationRepositories::MESSAGES`. */
  const NOT_GRANTED =
    "cannot be registered from an API key — SpecGuard has no current record of your GitHub " +
    "permissions. Sign in to SpecGuard in a browser and reconnect GitHub, then try again.";

  function refused(body: string) {
    return stubFetch({ status: 400, body }).fetch;
  }

  it("surfaces the message verbatim, and does not bury it in the body it came from", async () => {
    const error = await rejects(
      postJson(
        config,
        "/api/v1/repositories",
        { github_full_name: "acme/app" },
        refused(
          JSON.stringify({
            error: "bad_request",
            message: `acme/app ${NOT_GRANTED}`,
            details: [`acme/app ${NOT_GRANTED}`],
          }),
        ),
      ),
      /Sign in to SpecGuard in a browser and reconnect GitHub/,
    );

    // The whole sentence, not a prefix of it — the actionable half is at the END,
    // which is precisely what a 500-char truncation of a JSON blob would cut.
    assert.match(error.message, new RegExp(NOT_GRANTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // And NOT rendered as the raw document. `error":"bad_request` appearing here
    // would mean the body was echoed rather than read.
    assert.doesNotMatch(error.message, /"error"/);
    assert.doesNotMatch(error.message, /"details"/);
    assert.equal((error as ApiError).status, 400);
  });

  it("surfaces the other refusals the same one path carries", async () => {
    // Every refusal from this controller is `render_bad_request(...full_messages)`,
    // whether it came from the record's own rules or from the ownership gate, so
    // the branch must not be tuned to the grant sentence in particular.
    for (const message of [
      "Github full name has already been taken",
      "acme/app is not one of the repositories the SpecGuard GitHub App is installed on. Add it on GitHub, then pick it here.",
    ]) {
      const error = await rejects(
        postJson(config, "/api/v1/repositories", {}, refused(JSON.stringify({ error: "bad_request", message, details: [message] }))),
        /400/,
      );

      assert.match(error.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("reaches a GET through the same branch, because the contract is the API's and not one tool's", async () => {
    // `ingests_controller.rb` is the second caller of `render_bad_request` on
    // `origin/main`. Putting the branch in `describeFailure` rather than in the
    // write path is what makes it serve both, and this is that claim.
    await rejects(
      getJson(config, "/api/v1/repository", {}, refused('{"error":"bad_request","message":"Run is invalid","details":["Run is invalid"]}')),
      /Run is invalid/,
    );
  });

  for (const [shape, body] of [
    ["not JSON at all", "<html><body>Bad Request</body></html>"],
    ["JSON without a message", '{"error":"bad_request","details":[]}'],
    ["JSON whose message is not a string", '{"error":"bad_request","message":{"nested":"thing"}}'],
    ["JSON whose message is blank", '{"error":"bad_request","message":"   "}'],
    ["a JSON array", '["bad_request"]'],
  ] as const) {
    it(`falls back to the generic sentence for a 400 that is ${shape}`, async () => {
      // The other direction. A proxy's HTML error page is still worth showing an
      // operator — what must not happen is the branch inventing a sentence, or
      // swallowing the body because it could not find the key it hoped for.
      const error = await rejects(
        postJson(config, "/api/v1/repositories", {}, refused(body)),
        /SpecGuard answered 400/,
      );

      assert.match(error.message, /SpecGuard answered 400: /);
      assert.equal((error as ApiError).status, 400);
    });
  }

  it("leaves the other statuses' branches alone", async () => {
    // A 500 whose body happens to carry a `message` must NOT be re-described as
    // a refusal: this branch is keyed on 400 because that is the status the
    // contract is rendered at.
    const error = await rejects(
      postJson(config, "/api/v1/repositories", {}, stubFetch({ status: 500, body: '{"message":"boom"}' }).fetch),
      /SpecGuard answered 500/,
    );

    assert.doesNotMatch(error.message, /refused the request/);
  });
});

/**
 * THE 403 BRANCH — the same contract under the status `not_granted` is rendered at.
 *
 * `Api::V1::UserRepositoriesController#render_not_granted` renders
 * `{error: "not_granted", message:, grant:}` — the same `{error, message}` shape
 * the 400 branch reads, at a status `describeFailure` previously could not
 * speak. This is the MODAL first answer `registrable_repositories` gives (a nil
 * grant is every person who has not opened SpecGuard in a browser since the
 * feature shipped), and the sentence it carries names the operator's exact next
 * move — so it gets the identical remedy the 400 branch established, via the
 * one generalised extractor rather than a second copy beside it.
 *
 * Asserted in BOTH directions, for the same reason the 400 block is: a branch
 * that surfaced `message` whenever it found one would pass the first test
 * alone; what must hold is that a 403 which is NOT this contract still falls
 * back to showing the operator what actually came back.
 */
describe("a 403 that carries SpecGuard's own refusal", () => {
  const config = api("2000");

  /** Verbatim from `InstallationRepositories::MESSAGES.fetch(:not_granted)`, prefixed as the controller prefixes it. */
  const NOT_GRANTED =
    "Your repositories cannot be registered from an API key — SpecGuard has no current record of " +
    "your GitHub permissions. Sign in to SpecGuard in a browser and reconnect GitHub, then try " +
    "again.";

  function refused(body: string) {
    return stubFetch({ status: 403, body }).fetch;
  }

  it("surfaces the message verbatim through \"then try again\", and does not bury it in the body it came from", async () => {
    const error = await rejects(
      getJson(
        config,
        "/api/v1/repositories/registrable",
        {},
        refused(JSON.stringify({ error: "not_granted", message: NOT_GRANTED, grant: null })),
      ),
      /Sign in to SpecGuard in a browser and reconnect GitHub/,
    );

    // The whole sentence, not a prefix of it — the actionable half is at the END,
    // which is precisely what a 500-char truncation of a JSON blob would cut.
    assert.match(error.message, new RegExp(NOT_GRANTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // And NOT rendered as the raw document. `"error":"not_granted"` appearing
    // here would mean the body was echoed rather than read. The `grant` block
    // is simply ignored by the extractor, exactly as `details` is on the 400.
    assert.doesNotMatch(error.message, /"error"/);
    assert.doesNotMatch(error.message, /"grant"/);
    assert.equal((error as ApiError).status, 403);
  });

  for (const [shape, body] of [
    ["not JSON at all", "<html><body>Forbidden</body></html>"],
    ["JSON without a message", '{"error":"not_granted","grant":null}'],
    ["JSON whose message is not a string", '{"error":"not_granted","message":{"nested":"thing"}}'],
    ["JSON whose message is blank", '{"error":"not_granted","message":"   "}'],
    ["a JSON array", '["not_granted"]'],
  ] as const) {
    it(`falls back to the generic sentence for a 403 that is ${shape}`, async () => {
      // The other direction. A proxy's HTML error page is still worth showing an
      // operator — what must not happen is the branch inventing a sentence, or
      // swallowing the body because it could not find the key it hoped for.
      const error = await rejects(
        getJson(config, "/api/v1/repositories/registrable", {}, refused(body)),
        /SpecGuard answered 403/,
      );

      assert.match(error.message, /SpecGuard answered 403: /);
      assert.equal((error as ApiError).status, 403);
    });
  }

  it("leaves the other statuses' branches alone", async () => {
    // A 500 whose body happens to carry a `message` must NOT be re-described as
    // a refusal: this branch is keyed on 403 because that is the status
    // `render_not_granted` renders at — and a 401 or 404 is likewise untouched.
    const error = await rejects(
      getJson(config, "/api/v1/repositories/registrable", {}, stubFetch({ status: 500, body: '{"message":"boom"}' }).fetch),
      /SpecGuard answered 500/,
    );

    assert.doesNotMatch(error.message, /refused the request/);
  });
});

/**
 * THE 401 BRANCH — the one fork where SpecGuard names the cause itself.
 *
 * `Api::BaseController` answers every 401 with `{error: "unauthorized",
 * message}` and no `reason` — except the one arm its digest lookup licenses: a
 * token that resolves a REVOKED key renders `reason: "revoked"` plus a message
 * naming the remedy. Flattening that arm back into the wrong-kind sentence
 * tells an operator holding a REVOKED — but correctly-kind — key to re-check
 * configuration instead of rotating the key, which is the one diagnosis this
 * branch must never give.
 *
 * Asserted in BOTH directions, for the same reason the 400 and 403 blocks are:
 * a branch that surfaced `message` whenever it found one would pass the first
 * test alone. The discriminator is the `reason` field — the generic body
 * carries a message too — and every body that is not that exact disclosure
 * must keep reading as an unknown key, in the sentence the tool suites already
 * pin.
 */
describe("a 401 that carries SpecGuard's revoked-credential disclosure", () => {
  const config = api("2000");

  /** Verbatim from `Api::BaseController::REVOKED_CREDENTIAL_MESSAGE`. */
  const REVOKED =
    "This API key has been revoked. Mint a replacement key and update whatever presents this one.";

  /** The body `render_unauthorized` renders with its defaults — a message, but no `reason`. */
  const GENERIC = JSON.stringify({
    error: "unauthorized",
    message: "A valid Bearer API key is required.",
  });

  function unauthorized(body: string) {
    return stubFetch({ status: 401, body }).fetch;
  }

  it("hands the platform's message through verbatim, and never the wrong-kind sentence", async () => {
    const error = await rejects(
      getJson(
        config,
        "/api/v1/repository",
        {},
        unauthorized(JSON.stringify({ error: "unauthorized", reason: "revoked", message: REVOKED })),
      ),
      /Mint a replacement key/,
    );

    // EXACTLY the platform's sentence — no prefix, no framing, no trim. The
    // message IS the diagnosis, and reshaping it is how "mint a replacement"
    // decays back into a configuration lecture. The 401 status still rides
    // the error for anything downstream that branches on it.
    assert.equal(error.message, REVOKED);
    assert.equal((error as ApiError).status, 401);
  });

  it("reaches the write path through the same shared branch", async () => {
    // The 401 branch sits in `describeFailure`, so it serves every verb and —
    // parameterised on `api.credential` — every credential slot. One read-path
    // test does not prove the POST half of that claim.
    const error = await rejects(
      postJson(
        config,
        "/api/v1/repositories",
        { github_full_name: "acme/app" },
        unauthorized(JSON.stringify({ error: "unauthorized", reason: "revoked", message: REVOKED })),
      ),
      /Mint a replacement key/,
    );

    assert.equal(error.message, REVOKED);
  });

  it("keeps the canned sentence for the generic body the default render answers", async () => {
    // The generic 401 carries a `message` but NO `reason` — so a branch keyed
    // on message-presence instead of `reason` would fail exactly here, reading
    // an unknown key as a revoked one. The backend pins the miss arm: an
    // unknown token must keep reading as an unknown token.
    const error = await rejects(
      getJson(config, "/api/v1/repository", {}, unauthorized(GENERIC)),
      /SpecGuard rejected the API key \(401\)/,
    );

    assert.match(error.message, /must be an sgk_… key issued by https:\/\/sg\.example\.com/);
    assert.doesNotMatch(error.message, /Mint a replacement key/);
    assert.equal((error as ApiError).status, 401);
  });

  for (const [shape, body] of [
    ["a reason of another kind", '{"error":"unauthorized","reason":"expired","message":"come back later"}'],
    ["a revoked reason whose message is not a string", '{"error":"unauthorized","reason":"revoked","message":{"nested":"thing"}}'],
    ["a revoked reason whose message is blank", '{"error":"unauthorized","reason":"revoked","message":"   "}'],
    ["a revoked reason with no message at all", '{"error":"unauthorized","reason":"revoked"}'],
    ["not JSON at all", "<html><body>Unauthorized</body></html>"],
    ["a JSON array", '["unauthorized"]'],
  ] as const) {
    it(`degrades to the canned sentence for a 401 body that is ${shape}`, async () => {
      // Every non-disclosure body — including one that fails to parse — falls
      // back to today's sentence, never to a thrown parse error or an invented
      // reading. The canned sentence for THIS credential slot itself contains
      // the word "revoked" ("a revoked key's 401 names the revocation"), so
      // what is pinned is the platform remedy's ABSENCE plus the sentence's
      // own halves — never the bare word.
      const error = await rejects(
        getJson(config, "/api/v1/repository", {}, unauthorized(body)),
        /SpecGuard rejected the API key \(401\)/,
      );

      assert.match(error.message, /must be an sgk_… key issued by https:\/\/sg\.example\.com/);
      assert.doesNotMatch(error.message, /Mint a replacement key/);
      assert.equal((error as ApiError).status, 401);
    });
  }
});

/**
 * THE 404 BRANCH — the platform's own not-found body, surfaced before the hint.
 *
 * `Api::BaseController` rescues `ActiveRecord::RecordNotFound` into
 * `render_not_found`, which renders `{error: "not_found", message:}` at 404 —
 * and those messages are complete operator guidance ("No repository with that
 * id is available to this key." from `UserRepositoriesController#show`; the
 * raised case renders the sentence the raise site crafted, byte-pinned
 * producer-side). The mechanism underneath any exception-borne message is
 * unchanged and general: `Exception#as_json` is `to_s`, so a raise carrying a
 * message renders that message — only a message-less raise would render the
 * class name. On the endpoints this bridge wraps, the commonest such body is a
 * stale or wrong key id on the rotation/orphan-recovery arc the revoke tool
 * itself prescribes (mint replacement → deploy → revoke orphan), reaching here
 * through `repository.api_keys.find_by` and its crafted raise:
 * "No API key with that id belongs to this repository."
 * Answering it with the canned
 * endpoint-config hint recruits the reader toward the wrong remedy — debug
 * `SPECGUARD_ENDPOINT` instead of re-check WHICH key was named — the same
 * fault-assigning defect class the 401 branch's wrong-kind sentence was.
 *
 * Asserted in BOTH directions, for the same reason the 400, 403 and 401 blocks
 * are: a branch that surfaced `message` whenever it found one would pass the
 * first test alone. The discriminator is the `error` FIELD, never the presence
 * of a `message` — a body without `error: "not_found"` still names no cause at
 * all, so the canned endpoint hint stays the contract for it. For a 404 whose
 * body is a proxy's HTML or nothing at all, endpoint misconfiguration remains
 * the likeliest cause and the hint is the right diagnosis for it.
 */
describe("a 404 that carries SpecGuard's own not-found body", () => {
  const config = api("2000");

  /** Verbatim from `Api::V1::UserRepositoriesController#show`'s `render_not_found`. */
  const NOT_AVAILABLE = "No repository with that id is available to this key.";

  function notFound(body: string) {
    return stubFetch({ status: 404, body }).fetch;
  }

  it("surfaces the platform's message verbatim, and never the endpoint-config hint", async () => {
    const error = await rejects(
      deleteJson(
        config,
        "/api/v1/repositories/42/api_keys/999",
        notFound(JSON.stringify({ error: "not_found", message: NOT_AVAILABLE })),
      ),
      /No repository with that id is available to this key/,
    );

    // EXACTLY the platform's sentence — no prefix, no framing. The message IS
    // the diagnosis; reshaping it is how "re-check which key it named" decays
    // back into an endpoint-config lecture.
    assert.equal(error.message, NOT_AVAILABLE);

    // The inverse assertion: the fault-assigning string must not appear when
    // the platform named the cause. Its presence is precisely the measured
    // defect — an agent handed a stale key id sent to debug the endpoint.
    assert.doesNotMatch(error.message, /no such endpoint/);
    assert.doesNotMatch(error.message, /root URL/);
    assert.equal((error as ApiError).status, 404);
  });

  it("reaches a GET through the same shared branch, because the contract is the API's and not one verb's", async () => {
    // The 404 branch sits in `describeFailure`, which both transports route
    // through — one DELETE test does not prove the read half of that claim.
    const error = await rejects(
      getJson(
        config,
        "/api/v1/repositories/999",
        {},
        notFound(JSON.stringify({ error: "not_found", message: NOT_AVAILABLE })),
      ),
      /No repository with that id is available to this key/,
    );

    assert.equal(error.message, NOT_AVAILABLE);
    assert.equal((error as ApiError).status, 404);
  });

  for (const [shape, body] of [
    ["not JSON at all", "<html><body>Not Found</body></html>"],
    ["an empty body", ""],
    ["a JSON array", '["not_found"]'],
    ["JSON whose error is not not_found", '{"error":"gone","message":"come back later"}'],
    ["JSON without an error field at all", '{"message":"No repository with that id is available to this key."}'],
    ["JSON whose message is not a string", '{"error":"not_found","message":{"nested":"thing"}}'],
    ["JSON whose message is blank", '{"error":"not_found","message":"   "}'],
    ["JSON with no message at all", '{"error":"not_found"}'],
  ] as const) {
    it(`degrades to the canned endpoint hint for a 404 that is ${shape}`, async () => {
      // The fallback stays byte-identical to the answer every existing 404 pin
      // already locks: for a body that is not this contract — a proxy's HTML
      // page, an empty body — endpoint misconfiguration remains the likeliest
      // cause of a 404, and the hint names it. The error-absent-but-message-
      // present shape above is the discriminator's own test: a branch keyed on
      // message presence would fail exactly there, reading a stranger's body
      // as the platform's contract.
      const error = await rejects(
        deleteJson(config, "/api/v1/repositories/42/api_keys/999", notFound(body)),
        /no such endpoint \(404\)/,
      );

      assert.match(error.message, /Check that SPECGUARD_ENDPOINT is the deployment's root URL/);
      assert.doesNotMatch(error.message, /No repository with that id/);
      assert.equal((error as ApiError).status, 404);
    });
  }

  it("leaves the other statuses' branches alone", async () => {
    // A 500 whose body happens to carry `error: "not_found"` must NOT be
    // re-described as a not-found: this branch is keyed on 404 because that is
    // the status `render_not_found` renders at.
    const error = await rejects(
      getJson(
        config,
        "/api/v1/repositories/42",
        {},
        stubFetch({ status: 500, body: '{"error":"not_found","message":"boom"}' }).fetch,
      ),
      /SpecGuard answered 500/,
    );

    assert.doesNotMatch(error.message, /No repository with that id/);
  });
});

/**
 * The singular/plural branch point, extracted to one seam.
 *
 * Synchronous pins on purpose: `repositoryTarget` only PAIRS a credential
 * with a path and never reaches the network, so every assertion below
 * resolves without a fetch — and the pair the two tools used to keep as one
 * branch point is pinned here at the seam itself, beside the transports the
 * pair is handed to.
 */
describe("repositoryTarget — the singular/plural (path, credential) pair, chosen together", () => {
  const ENDPOINT_ENV = {
    SPECGUARD_ENDPOINT: "https://sg.example.com",
    SPECGUARD_API_KEY: "sgk_test",
  };

  it("pairs the singular path with the sgk_ slot when no repository is named", () => {
    const { api, path } = repositoryTarget(loadConfig(ENDPOINT_ENV), undefined);

    assert.equal(path, "/api/v1/repository");
    assert.equal(api.endpoint, "https://sg.example.com");
    assert.equal(api.apiKey, "sgk_test");
    assert.equal(api.credential.variable, "SPECGUARD_API_KEY");
  });

  it("refuses the singular arm when the sgk_ slot is unset — even with a member key present", () => {
    // The wiring pin for the arm above: the singular path belongs to
    // `requireApiConfig` specifically, never to whichever member helper reads
    // `SPECGUARD_USER_API_KEY`. Swapping the seam's singular arm to a member
    // helper turns this pin and the one above red together, and with them
    // every tool pin that rides the singular path.
    assert.throws(
      () =>
        repositoryTarget(
          loadConfig({
            SPECGUARD_ENDPOINT: "https://sg.example.com",
            SPECGUARD_API_KEY: undefined,
            SPECGUARD_USER_API_KEY: "sgu_test",
          }),
          undefined,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /SPECGUARD_API_KEY is not set/);
        assert.match(error.message, /an sgk_… key/);
        return true;
      },
    );
  });

  it("pairs the plural path with the agent key when a repository is named and only the agent key is set", () => {
    const { api, path } = repositoryTarget(
      loadConfig({
        SPECGUARD_ENDPOINT: "https://sg.example.com",
        SPECGUARD_AGENT_API_KEY: "sga_test",
      }),
      "42",
    );

    assert.equal(path, "/api/v1/repositories/42");
    assert.equal(api.endpoint, "https://sg.example.com");
    assert.equal(api.apiKey, "sga_test");
    assert.equal(api.credential.variable, "SPECGUARD_AGENT_API_KEY");
  });

  it("pairs the plural path with the user key when that is the only member credential set", () => {
    const { api, path } = repositoryTarget(
      loadConfig({
        SPECGUARD_ENDPOINT: "https://sg.example.com",
        SPECGUARD_USER_API_KEY: "sgu_test",
      }),
      "42",
    );

    assert.equal(path, "/api/v1/repositories/42");
    assert.equal(api.apiKey, "sgu_test");
    assert.equal(api.credential.variable, "SPECGUARD_USER_API_KEY");
  });

  it("prefers the agent key on the plural arm when both member credentials are set", () => {
    const { api, path } = repositoryTarget(
      loadConfig({
        ...ENDPOINT_ENV,
        SPECGUARD_AGENT_API_KEY: "sga_test",
        SPECGUARD_USER_API_KEY: "sgu_test",
      }),
      "42",
    );

    assert.equal(path, "/api/v1/repositories/42");
    assert.equal(api.apiKey, "sga_test");
  });

  it("refuses the plural arm naming BOTH member variables when neither is set — the sgk_ slot being present is not the problem", () => {
    assert.throws(
      () => repositoryTarget(loadConfig(ENDPOINT_ENV), "42"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /SPECGUARD_USER_API_KEY or SPECGUARD_AGENT_API_KEY is not set/);
        assert.match(error.message, /sgu_… key/);
        assert.match(error.message, /sga_… key/);
        assert.doesNotMatch(error.message, /SPECGUARD_API_KEY is not set/);
        return true;
      },
    );
  });

  it("percent-encodes the repository into the plural path", () => {
    const { path } = repositoryTarget(
      loadConfig({ ...ENDPOINT_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" }),
      "a b/c",
    );

    assert.equal(path, "/api/v1/repositories/a%20b%2Fc");
  });
});
