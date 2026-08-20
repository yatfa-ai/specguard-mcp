import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
