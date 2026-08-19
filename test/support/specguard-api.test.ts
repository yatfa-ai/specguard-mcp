import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { ApiError, SpecGuardMcpError } from "../../src/errors.js";
import { getJson, getJsonObject, requireApiConfig } from "../../src/support/specguard-api.js";
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
