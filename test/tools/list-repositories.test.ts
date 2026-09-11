import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArgumentError } from "../../src/errors.js";
import listRepositories from "../../src/tools/list-repositories.js";
import getRepositoryOverview from "../../src/tools/repository-overview.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the environment an operator who wants just this tool has. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** Only the REPOSITORY key — the environment every operator had before this tool existed. */
const REPOSITORY_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_API_KEY: "sgk_test",
};

/**
 * The five fields `Api::V1::UserRepositoriesController#serialize` actually
 * serves, in a body shaped as that controller renders it.
 *
 * `role` is the one field this surface adds over `GET /api/v1/repository`'s
 * `repository` block, and the fixture carries BOTH of its values: the list
 * mixes owned repositories with shared ones, and a fixture with only `"owner"`
 * rows would let a bridge that dropped or defaulted the field still pass.
 */
const BODY = JSON.stringify({
  repositories: [
    {
      id: "0b2f1e14-6f6e-4a1e-9a34-9f2b6a1c77aa",
      full_name: "acme/app",
      name: "app",
      registered_at: "2026-01-04T09:15:00Z",
      role: "owner",
    },
    {
      id: "5c9d2a77-1f0b-4c8e-8f5a-2d3e4b5c6d7e",
      full_name: "acme/billing",
      name: "billing",
      registered_at: "2026-02-11T17:42:03Z",
      role: "member",
    },
  ],
});

describe("list_repositories", () => {
  it("asks the user-scoped endpoint, with the user key and no arguments on the wire", async () => {
    const http = stubFetch({ body: BODY });

    await listRepositories.run({}, toolContext({ env: USER_ENV, fetch: http.fetch }));

    const request = http.requests[0];
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories");
    // The plural path and the `sgu_` key together: singular `/repository` with
    // this key, or plural with the `sgk_` one, are both 401s at the deployment.
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("passes the deployment's body back unmodified, every field of every entry", async () => {
    // `deepEqual` against the PARSED fixture rather than a hand-listed subset:
    // this bridge is a thin client, so a field added upstream must reach the
    // agent without a release here, and any reshaping — renaming `full_name`,
    // dropping `role`, sorting the array — has to fail rather than be reported
    // as a nicer answer.
    const result = await listRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));

    const entry = (result.structured?.["repositories"] as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(entry ?? {}).sort(), [
      "full_name",
      "id",
      "name",
      "registered_at",
      "role",
    ]);
  });

  it("renders the same object it returns, so the two cannot disagree", async () => {
    const result = await listRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("serves an empty list as an answer, not as a failure", async () => {
    // No access and an error are different states with different next moves,
    // and SpecGuard says the first with a 200 — a person who has registered
    // nothing is an ordinary way to arrive.
    const result = await listRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: '{"repositories":[]}' }).fetch }),
    );

    assert.deepEqual(result.structured, { repositories: [] });
  });

  it("refuses a JSON body that is not an object", async () => {
    await rejects(
      listRepositories.run({}, toolContext({ env: USER_ENV, fetch: stubFetch({ body: "[]" }).fetch })),
      /not an object/,
    );
  });
});

/**
 * THE NARROWING ASKS — `?q=`, `?role=owned|shared` and `?sort=stale`, read by
 * the endpoint since specguard `ef6236d` (SPGD-940) through
 * `RepositoryNarrowing`, forwarded here since SPGD-1037.
 *
 * Three properties are pinned, in the order the landed family pins them:
 *
 * 1. SCHEMA → WIRE MAPPING. Every schema property is forwarded under the
 *    query key of the same name, and the enums name the server's OWN accepted
 *    vocabularies (`RepositoryNarrowing`'s ROLES and SORTS) rather than a
 *    second list this bridge keeps in step by hand.
 * 2. VERBATIM FORWARDING. A defined ask reaches the wire exactly as given —
 *    the server owns the vocabulary clamp (an out-of-vocabulary value settles
 *    to the no-ask, never a 400), so this side validates shape only.
 * 3. THE NO-ASK PIN. Omitted, undefined and blank asks all compose to the
 *    request this tool made before it had arguments at all — the bare
 *    `/api/v1/repositories` URL. The falsification contract of this slice
 *    rides on that pin: reverting `run`'s query build fails exactly the
 *    forwarding tests below and leaves it green.
 *
 * Composition is asserted onto ONE request because that is what the server
 * contract is: the asks chain onto one relation (`narrow_repositories`
 * composes boundary → ?q= → ?role= → ?sort=stale), so a client that had to
 * call once per ask would be paying for a round trip the endpoint never asked
 * for.
 */
describe("list_repositories — the narrowing asks", () => {
  it("forwards every schema property under the query key of the same name, with the server's own vocabularies", () => {
    const properties = (listRepositories.inputSchema.properties ?? {}) as Record<
      string,
      { enum?: string[] }
    >;

    // The mapping itself: one property per ask, named as the server reads it.
    assert.deepEqual(Object.keys(properties).sort(), ["q", "role", "sort"]);

    // The vocabularies are the SERVER's, quoted in schema form — a value the
    // endpoint would clamp to no-ask is not offered to a schema-honouring
    // client at all.
    assert.deepEqual(properties["role"]?.enum, ["owned", "shared"]);
    assert.deepEqual(properties["sort"]?.enum, ["stale"]);
  });

  it("passes ?q= through when a search is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await listRepositories.run({ q: "billing" }, toolContext({ env: USER_ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories?q=billing");
  });

  it("passes ?role=owned and ?role=shared through verbatim, in the ASK spelling rather than the response field's", async () => {
    // The response field reads `owner`/`member`; the ask reads
    // `owned`/`shared`. Forwarding the RESPONSE spelling (a plausible
    // refactor: "normalise" the two) would send `role=owner`, which the server
    // clamps to the no-ask — the full list, silently — which is why BOTH
    // accepted values are pinned on the wire exactly as spelled.
    for (const role of ["owned", "shared"] as const) {
      const http = stubFetch({ body: BODY });

      await listRepositories.run({ role }, toolContext({ env: USER_ENV, fetch: http.fetch }));

      assert.equal(http.requests[0]?.url, `https://sg.example.com/api/v1/repositories?role=${role}`);
    }
  });

  it("passes ?sort=stale through when the stale-first ordering is asked for", async () => {
    const http = stubFetch({ body: BODY });

    await listRepositories.run({ sort: "stale" }, toolContext({ env: USER_ENV, fetch: http.fetch }));

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories?sort=stale");
  });

  it("composes several asks onto ONE request, in the server's own composition", async () => {
    // `narrow_repositories` chains boundary → ?q= → ?role= → ?sort=stale onto
    // ONE relation, so the asks ride one request rather than one call each —
    // and the bridge must not stand between an agent and that composition.
    const http = stubFetch({ body: BODY });

    await listRepositories.run(
      { q: "acme", role: "shared", sort: "stale" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests.length, 1);
    assert.equal(
      http.requests[0]?.url,
      "https://sg.example.com/api/v1/repositories?q=acme&role=shared&sort=stale",
    );
  });

  it("sends NOTHING for a blank ask — declining and omitting are the same wire request", async () => {
    // The established spelling (`optionalString` returning undefined for
    // blank, `getJson` omitting undefined): a blank value is no ask, not an
    // empty filter — `?role=` would be read by the server's guard as no-ask
    // anyway, but sending it would make the wire disagree with the call the
    // agent believes it made.
    for (const asks of [
      { q: "  " },
      { role: "" },
      { sort: " " },
      { q: undefined, role: undefined, sort: undefined },
    ]) {
      const http = stubFetch({ body: BODY });

      await listRepositories.run(asks, toolContext({ env: USER_ENV, fetch: http.fetch }));

      assert.equal(
        http.requests[0]?.url,
        "https://sg.example.com/api/v1/repositories",
        `expected no ask on the wire for ${JSON.stringify(asks)}`,
      );
    }
  });

  it("refuses a non-string ask by name, before any request is made", async () => {
    // The enum guides a schema-honouring client, but `server.ts` forwards
    // `arguments` unvalidated — so the type clamp here is the only thing that
    // stands between a number and the wire. Wrong SHAPE is refused by name;
    // out-of-vocabulary VALUES are the server's to clamp, which is why this
    // asserts on `q` (a plain string ask) rather than reimplementing the
    // server's vocabulary check.
    const http = stubFetch({ body: BODY });

    const error = await rejects(
      listRepositories.run({ q: 42 }, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`q` must be a string\./,
    );

    assert.equal(http.requests.length, 0, "a malformed ask must not reach the wire");
    assert.ok(error instanceof ArgumentError, `expected an ArgumentError, got ${error.name}`);
  });

  it("still passes a narrowed body through unmodified — an ask changes the request, never the pass-through", async () => {
    // The response half of the contract is untouched by the asks: whatever
    // comes back is the same object, whatever was asked for.
    const result = await listRepositories.run(
      { q: "app", role: "owned", sort: "stale" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });
});

/**
 * THE SEAM THIS TICKET EXISTS FOR, asserted in BOTH directions.
 *
 * SpecGuard's `Api::BaseController` decides which credential table to consult
 * from the token's prefix, before it reads any of them, and answers 401 on a
 * mismatch — so `sgk_` and `sgu_` refuse each other by design. One variable
 * therefore cannot serve both tools, and the regression this file is here to
 * prevent is a future refactor collapsing the two slots back into one: assert
 * only that the user tool wants the user key, and a change that made BOTH tools
 * read `SPECGUARD_USER_API_KEY` would still pass.
 */
describe("the two credential slots refuse each other's tools", () => {
  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ body: BODY });

    const error = await rejects(
      listRepositories.run({}, toolContext({ env: REPOSITORY_ENV, fetch: http.fetch })),
      /SPECGUARD_USER_API_KEY is not set/,
    );

    // The prefix, so an operator holding two similar-looking tokens knows which
    // of them to paste — and no mention of the variable they DID set, which is
    // correct and is not the problem.
    assert.match(error.message, /sgu_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });

  it("leaves get_repository_overview working when only the repository key is set", async () => {
    // The half that makes the assertion above a seam rather than a swap: the
    // tool that worked before must still work, unchanged, in the same
    // environment that the new tool refuses.
    const result = await getRepositoryOverview.run(
      {},
      toolContext({ env: REPOSITORY_ENV, fetch: stubFetch({ body: '{"repository":{"full_name":"acme/app"}}' }).fetch }),
    );

    assert.deepEqual(result.structured, { repository: { full_name: "acme/app" } });
  });

  it("names the REPOSITORY variable when only the user key is set", async () => {
    const http = stubFetch({ body: "{}" });

    const error = await rejects(
      getRepositoryOverview.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /SPECGUARD_API_KEY is not set/,
    );

    assert.match(error.message, /sgk_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_USER_API_KEY/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });

  it("leaves list_repositories working when only the user key is set", async () => {
    const result = await listRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
  });

  it("reports both missing halves in one sentence rather than one per round trip", async () => {
    // `requireApiConfig`'s stated property, inherited by the second helper
    // rather than re-derived: an operator who set neither learns that in one
    // call instead of fixing the endpoint, re-calling, and being told about the
    // key. The `and` is what makes it one sentence and not two.
    const error = await rejects(
      listRepositories.run({}, toolContext({ env: {} })),
      /SPECGUARD_ENDPOINT and SPECGUARD_USER_API_KEY are not set/,
    );

    assert.equal(
      error.message.split(". ").filter((clause) => clause.includes("not set")).length,
      1,
    );
  });
});

/**
 * THE TRAP THIS REPO HAS ALREADY PAID FOR ONCE, IN THE OTHER AXIS.
 *
 * `describeFailure`'s 401 branch is shared by every HTTP-backed tool, and it
 * used to hardcode `SPECGUARD_API_KEY`, `sgk_…` and "keys are per-repository".
 * A user-scoped tool routed through `getJson` would have inherited all three
 * verbatim — three sentences, every one of them false of it, naming a variable
 * its operator may never have touched. `endpointVariable` already fixes exactly
 * this defect for the endpoint one branch down.
 *
 * BOTH messages are asserted HERE, in one place, on purpose: what has to hold is
 * that they are DIFFERENT, and a per-tool assertion in a per-tool file can be
 * satisfied by two identical strings that each happen to contain the substring
 * that file looked for.
 */
describe("a 401 names the variable the tool that hit it actually reads", () => {
  const unauthorized = () => stubFetch({ status: 401, body: '{"error":"unauthorized"}' }).fetch;

  async function refusal(
    tool: typeof listRepositories,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    const error = await rejects(
      tool.run({}, toolContext({ env, fetch: unauthorized() })),
      /rejected the API key/,
    );

    return error.message;
  }

  it("tells a list_repositories caller about the user key, and nothing about the other one", async () => {
    const message = await refusal(listRepositories, USER_ENV);

    assert.match(message, /SPECGUARD_USER_API_KEY must be an sgu_… key/);
    // The three inherited falsehoods, each named so a regression is legible
    // rather than a diff of one long string.
    assert.doesNotMatch(message, /SPECGUARD_API_KEY/);
    assert.doesNotMatch(message, /per-repository/);
    assert.doesNotMatch(message, /must be an sgk_/);
  });

  it("still tells a get_repository_overview caller about the repository key", async () => {
    const message = await refusal(getRepositoryOverview, REPOSITORY_ENV);

    assert.match(message, /SPECGUARD_API_KEY must be an sgk_… key/);
    assert.match(message, /per-repository/);
    assert.doesNotMatch(message, /SPECGUARD_USER_API_KEY/);
  });

  it("produces two visibly different strings for the same status", async () => {
    // The check neither assertion above can make on its own. A `describeFailure`
    // that read the credential from the wrong place — or a `requireUserApiConfig`
    // that passed the repository `Credential` — would satisfy one of the two
    // above and be caught only by comparing them.
    assert.notEqual(
      await refusal(listRepositories, USER_ENV),
      await refusal(getRepositoryOverview, REPOSITORY_ENV),
    );
  });

  it("still names the endpoint variable the operator set, on both tools", async () => {
    // The 401 branch is the one place that hardcoded a variable name; the
    // branches around it read `api.endpointVariable`. Adding a second credential
    // must not have cost that, so the alias spelling is pinned on the new tool
    // too rather than assumed to be inherited.
    const viaAlias = { SPECGUARD_URL: "https://sg.example.com", SPECGUARD_USER_API_KEY: "sgu_test" };

    await rejects(
      listRepositories.run({}, toolContext({ env: viaAlias, fetch: stubFetch({ status: 404 }).fetch })),
      /Check that SPECGUARD_URL is the deployment's root URL/,
    );
  });
});
