import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { ApiError, SpecGuardMcpError } from "../../src/errors.js";
import {
  getJson,
  getJsonObject,
  postJson,
  postJsonObject,
  requireApiConfig,
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
