import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ArgumentError, ConfigError } from "../../src/errors.js";
import addRepository from "../../src/tools/add-repository.js";
import { rejects, stubFetch, stubSlowFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool answers to. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** Only the REPOSITORY key — the environment of an operator who has not set the user one. */
const REPOSITORY_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_API_KEY: "sgk_test",
};

/**
 * The 201 exactly as `Api::V1::UserRepositoriesController#registered_body`
 * renders it — both blocks, every field.
 *
 * `api_key.token` is the field this fixture exists for. The controller annotates
 * it "⚠️ THE ONLY TIME THIS VALUE EXISTS ANYWHERE": nothing stores it and no
 * endpoint can re-serve it, so a bridge that dropped or renamed it on this last
 * hop would destroy a value rather than merely garble one.
 */
const CREATED = JSON.stringify({
  repository: {
    id: "0b2f1e14-6f6e-4a1e-9a34-9f2b6a1c77aa",
    full_name: "acme/billing",
    name: "billing",
    registered_at: "2026-03-02T11:20:00Z",
  },
  api_key: {
    name: "Default CI Key",
    token: "sgk_live_9f2b6a1c77aa0b2f1e146f6e4a1e9a34",
    hint: "…9a34",
    created_at: "2026-03-02T11:20:00Z",
  },
});

describe("add_repository", () => {
  it("POSTs the name top-level, to the user-scoped endpoint, with the user key", async () => {
    // THE central claim of this tool, and the one the suite could not make
    // before `stubs.ts` recorded a method and a body. Every assertion here is
    // separately falsifiable: a GET fails the first, an empty body the third,
    // and a body nested under `repository` — the Rails-form shape the controller
    // deliberately does NOT permit — fails it too.
    const http = stubFetch({ status: 201, body: CREATED });

    await addRepository.run(
      { full_name: "acme/billing" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
    assert.deepEqual(JSON.parse(request?.body ?? "null"), { github_full_name: "acme/billing" });
  });

  it("sends the name under `github_full_name` and nothing else", async () => {
    // The key name is the contract (`create_params` is `permit(:github_full_name)`),
    // so a body that carried the right value under `full_name` would be silently
    // dropped by Rails and the registration refused for a blank name. Asserting
    // the exact key set is what catches that, where a `deepEqual` on the value
    // alone would not.
    const http = stubFetch({ status: 201, body: CREATED });

    await addRepository.run(
      { full_name: "acme/billing" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.deepEqual(Object.keys(JSON.parse(http.requests[0]?.body ?? "{}")), ["github_full_name"]);
  });

  it("trims a name an agent assembled by concatenation", async () => {
    // The shape check `requireString` performs, observed on the wire: leading or
    // trailing whitespace is not part of what the caller meant to send, and
    // SpecGuard would refuse " acme/billing" as a malformed name.
    const http = stubFetch({ status: 201, body: CREATED });

    await addRepository.run(
      { full_name: "  acme/billing\n" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.deepEqual(JSON.parse(http.requests[0]?.body ?? "null"), { github_full_name: "acme/billing" });
  });

  it("hands the 201 back whole, with the reveal-once token intact", async () => {
    // `deepEqual` against the PARSED fixture rather than a hand-listed subset,
    // for the reason `list_repositories` states — this is a thin client. It
    // matters more here: `api_key.token` exists nowhere else, so reshaping on
    // this hop loses a value rather than renaming a retrievable one.
    const result = await addRepository.run(
      { full_name: "acme/billing" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 201, body: CREATED }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(CREATED));

    const apiKey = result.structured?.["api_key"] as Record<string, unknown>;
    assert.equal(apiKey["token"], "sgk_live_9f2b6a1c77aa0b2f1e146f6e4a1e9a34");
    assert.deepEqual(Object.keys(apiKey).sort(), ["created_at", "hint", "name", "token"]);

    const repository = result.structured?.["repository"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(repository).sort(), ["full_name", "id", "name", "registered_at"]);
  });

  it("renders the same object it returns, so the two cannot disagree", async () => {
    const result = await addRepository.run(
      { full_name: "acme/billing" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 201, body: CREATED }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
    // The token has to survive into the TEXT rendering too — a client that shows
    // only text is the one case where a dropped token is invisible until it is
    // needed.
    assert.match(result.text, /sgk_live_9f2b6a1c77aa0b2f1e146f6e4a1e9a34/);
  });

  it("refuses a JSON body that is not an object", async () => {
    await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 201, body: "[]" }).fetch }),
      ),
      /not an object/,
    );
  });
});

/**
 * THE ARGUMENT, CHECKED BEFORE ANYTHING LEAVES THE PROCESS.
 *
 * Argument shape is the one failure class the agent can fix unaided on the next
 * call, and on a WRITE the ordering is not a nicety: a malformed call must not
 * cost a registration attempt to discover. So each case below asserts BOTH that
 * the refusal is an `ArgumentError` and that no request was made — the second is
 * what makes it a claim about ordering rather than about wording.
 */
describe("add_repository refuses a malformed call before it writes anything", () => {
  for (const [shape, args] of [
    ["missing", {}],
    ["undefined", { full_name: undefined }],
    ["null", { full_name: null }],
    ["blank", { full_name: "" }],
    ["only whitespace", { full_name: "   " }],
    ["a number", { full_name: 42 }],
    ["an object", { full_name: { org: "acme", repo: "billing" } }],
  ] as const) {
    it(`refuses a \`full_name\` that is ${shape}, and sends nothing`, async () => {
      const http = stubFetch({ status: 201, body: CREATED });

      const error = await rejects(
        addRepository.run(args as Record<string, unknown>, toolContext({ env: USER_ENV, fetch: http.fetch })),
        /full_name/,
      );

      assert.ok(error instanceof ArgumentError, `expected an ArgumentError, got ${error.name}`);
      assert.equal(http.requests.length, 0, "a malformed call must not reach the deployment");
    });
  }

  it("checks the argument BEFORE the config, so the message names the fixable thing", async () => {
    // Both are wrong here. The argument is checked first, so the agent is told
    // about the half it can fix on its own next call rather than about an
    // environment variable it cannot set.
    const error = await rejects(
      addRepository.run({}, toolContext({ env: {} })),
      /full_name/,
    );

    assert.ok(error instanceof ArgumentError);
    assert.doesNotMatch(error.message, /SPECGUARD/);
  });

  it("does NOT re-validate the org/repo format on this side", async () => {
    // Deliberate, and asserted so a later "helpful" addition has to argue with a
    // test. `Repository` validates the name and the refusal comes back in
    // SpecGuard's own words through the 400 branch; a second format rule here
    // would be free to drift and would surface as this bridge rejecting a name
    // the platform would have accepted.
    const http = stubFetch({ status: 201, body: CREATED });

    await addRepository.run(
      { full_name: "not-a-valid-repo-name" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests.length, 1, "the platform is the authority on the format");
    assert.deepEqual(JSON.parse(http.requests[0]?.body ?? "null"), { github_full_name: "not-a-valid-repo-name" });
  });
});

/**
 * THE REFUSAL AN OPERATOR WILL ACTUALLY MEET FIRST.
 *
 * `GrantVerifier` fails closed on a grant that is missing or stale, which is
 * every person who has not opened SpecGuard in a browser since this shipped —
 * the controller calls that "an ordinary state and not an error". The sentence
 * names the exact next move, and it is worth nothing if it arrives truncated
 * inside a JSON blob.
 */
describe("add_repository surfaces SpecGuard's own refusal", () => {
  const NOT_GRANTED =
    "cannot be registered from an API key — SpecGuard has no current record of your GitHub " +
    "permissions. Sign in to SpecGuard in a browser and reconnect GitHub, then try again.";

  it("passes the :not_granted sentence through to the agent verbatim", async () => {
    const message = `acme/billing ${NOT_GRANTED}`;
    const error = await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 400,
            body: JSON.stringify({ error: "bad_request", message, details: [message] }),
          }).fetch,
        }),
      ),
      /Sign in to SpecGuard in a browser and reconnect GitHub, then try again/,
    );

    // Not rendered as the document it arrived in — the actionable clause sits at
    // the END of the sentence, which is exactly what truncating a JSON blob cuts.
    assert.doesNotMatch(error.message, /"details"/);
  });

  it("still shows the body when a 400 is not that contract", async () => {
    // The other direction, asserted at tool level too: the fallback must not be
    // silence, because a proxy's error page is still what the operator needs to
    // see to work out that they are not talking to SpecGuard at all.
    await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 400, body: "<html>Bad Request</html>" }).fetch }),
      ),
      /SpecGuard answered 400: <html>Bad Request<\/html>/,
    );
  });
});

/**
 * THE CREDENTIAL, IN BOTH DIRECTIONS.
 *
 * `describeFailure`'s 401 branch is shared by every HTTP-backed tool and reads
 * the variable and prefix off `api.credential`. A new tool inherits that
 * correctly only if it asked for the right `Credential` in the first place, so
 * the wording is pinned here rather than assumed from the tool one file over.
 */
describe("add_repository names the credential it actually reads", () => {
  it("names SPECGUARD_USER_API_KEY on a 401, and never the repository variable", async () => {
    const error = await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 401, body: '{"error":"unauthorized"}' }).fetch }),
      ),
      /rejected the API key/,
    );

    assert.match(error.message, /SPECGUARD_USER_API_KEY must be an sgu_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY must be/);
    assert.doesNotMatch(error.message, /per-repository/);
    assert.doesNotMatch(error.message, /must be an sgk_/);
  });

  it("asks for the user key at CALL time, not at boot, and sends nothing without it", async () => {
    // The server must still start for an operator who set only the repository
    // key — every tool that does not need this credential is unaffected. That is
    // why the failure is a `ConfigError` raised here rather than at load.
    const http = stubFetch({ status: 201, body: CREATED });

    const error = await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({ env: REPOSITORY_ENV, fetch: http.fetch }),
      ),
      /SPECGUARD_USER_API_KEY is not set/,
    );

    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${error.name}`);
    assert.match(error.message, /sgu_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });

  it("reports both missing halves in one sentence", async () => {
    const error = await rejects(
      addRepository.run({ full_name: "acme/billing" }, toolContext({ env: {} })),
      /SPECGUARD_ENDPOINT and SPECGUARD_USER_API_KEY are not set/,
    );

    assert.equal(
      error.message.split(". ").filter((clause) => clause.includes("not set")).length,
      1,
    );
  });

  it("names the endpoint variable the operator actually set", async () => {
    const viaAlias = { SPECGUARD_URL: "https://sg.example.com", SPECGUARD_USER_API_KEY: "sgu_test" };

    await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({ env: viaAlias, fetch: stubFetch({ status: 404 }).fetch }),
      ),
      /Check that SPECGUARD_URL is the deployment's root URL/,
    );
  });
});

/**
 * THE HAZARD THE DESCRIPTION MUST STATE.
 *
 * `types.ts`: the description is "prompt material, not documentation … the
 * entire basis on which a model decides whether to call the tool". This tool
 * writes, is not idempotent, and returns a token that exists exactly once — an
 * agent that learns any of those by hitting it has already lost the token.
 *
 * Asserted rather than trusted to review, because a description is the one part
 * of a tool nothing else exercises: it can be edited down to nothing and every
 * other test in this file still passes.
 */
describe("the add_repository description arms the agent before it commits", () => {
  const description = addRepository.description;

  it("says the timeout can leave the write done", () => {
    assert.match(description, /SPECGUARD_TIMEOUT_MS/);
    assert.match(description, /not idempotent/i);
  });

  it("says the token is shown once", () => {
    assert.match(description, /ONCE AND NEVER AGAIN|once and never again/);
  });

  it("names the browser as the precondition, since no argument can substitute", () => {
    assert.match(description, /browser/i);
  });

  it("names the credential it reads, and distinguishes it from the other one", () => {
    assert.match(description, /SPECGUARD_USER_API_KEY/);
    assert.match(description, /sgu_/);
    assert.match(description, /sgk_/);
  });
});

/**
 * THE DEADLINE, AT TOOL LEVEL.
 *
 * The transport tests prove `postJson` is bounded; this proves the TOOL routes
 * through it. A tool that reached for `globalThis.fetch` directly, or grew its
 * own client, would pass every other test in this file.
 */
describe("add_repository is bounded by SPECGUARD_TIMEOUT_MS", () => {
  let socket: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    socket = setInterval(() => {}, 1_000);
  });

  afterEach(() => {
    clearInterval(socket);
  });

  it("gives up on a body that never arrives", { timeout: 5_000 }, async () => {
    const http = stubSlowFetch("never", { status: 201 });

    await rejects(
      addRepository.run(
        { full_name: "acme/billing" },
        toolContext({
          env: { ...USER_ENV, SPECGUARD_TIMEOUT_MS: "50" },
          fetch: http.fetch,
        }),
      ),
      /https:\/\/sg\.example\.com did not respond within 50ms/,
    );

    // The POST went out — this is the hazard the description warns about, and
    // the state in which the registration may have succeeded anyway.
    assert.equal(http.requests[0]?.method, "POST");
  });
});
