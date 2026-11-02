import assert from "node:assert/strict";
import { describe, it } from "node:test";
import removeRepositoryRun from "../../src/tools/remove-repository-run.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the credential this tool reads. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** Only the AGENT key — the environment an agent-configured operator has. */
const AGENT_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_AGENT_API_KEY: "sga_test",
};

/** The `204` with NO body — the deployment's whole success answer. */
const NO_CONTENT = { status: 204, body: "" };

describe("remove_repository_run", () => {
  it("issues a DELETE scoped to the repository, with no body", async () => {
    const http = stubFetch(NO_CONTENT);

    await removeRepositoryRun.run(
      { repository_id: "42", run_id: "7" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/runs/7");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("encodes both ids as path segments", async () => {
    // `requireString` passes whatever it is handed through, and both ids land
    // in the PATH — a value that is not a bare number must not be able to
    // change the shape of the URL the server reads.
    const http = stubFetch(NO_CONTENT);

    await removeRepositoryRun.run(
      { repository_id: "42", run_id: "7" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    assert.equal(http.requests[0]?.url, "https://sg.example.com/api/v1/repositories/42/runs/7");
  });

  it("says the run is gone AND names the anchor consequence", async () => {
    // The ticket's own sentence for this tool: the success text must say the
    // run is gone AND that the overview's latest_run and growth blocks may now
    // anchor on an older run — the one part of the verb's consequence the
    // deployment's empty 204 cannot carry, and the reason an agent must
    // re-read the overview instead of trusting figures anchored on the run it
    // just removed.
    const result = await removeRepositoryRun.run(
      { repository_id: "42", run_id: "7" },
      toolContext({ env: USER_ENV, fetch: stubFetch(NO_CONTENT).fetch }),
    );

    assert.match(result.text, /Run 7 deleted \(204\)\./);
    assert.match(result.text, /gone/);
    assert.match(result.text, /latest_run/);
    assert.match(result.text, /older run/);
    assert.deepEqual(result.structured, { repository_id: "42", run_id: "7", deleted: true });
  });

  it("refuses a missing run_id before anything is sent", async () => {
    const http = stubFetch(NO_CONTENT);

    await rejects(
      removeRepositoryRun.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`run_id` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a delete");
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch(NO_CONTENT);

    await rejects(
      removeRepositoryRun.run(
        { run_id: "7" },
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0, "a malformed call must not cost a delete");
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    // A member without `repo.delete` — the same gate `remove_repository`
    // answers, so the two destructive verbs refuse the same people the same
    // way.
    await rejects(
      removeRepositoryRun.run(
        { repository_id: "42", run_id: "7" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 403,
            body: JSON.stringify({
              error: "forbidden",
              message: "You do not have permission to do that on this repository.",
            }),
          }).fetch,
        }),
      ),
      /SpecGuard refused the request \(403\): You do not have permission to do that on this repository\./,
    );
  });

  it("keeps the 404 branch — the scoping rule's own answer", async () => {
    // A run id belonging to a DIFFERENT repository is a 404 server-side
    // (`repository.test_runs.find_by` + its crafted raise), never a
    // cross-repository delete. The branch here is the deployment's; the
    // bridge adds no check of its own.
    await rejects(
      removeRepositoryRun.run(
        { repository_id: "42", run_id: "999" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("surfaces the platform's own 404 sentence when the foreign-or-unknown run id carries a body", async () => {
    // The raise carries the controller's own crafted sentence — "belongs to
    // this repository" — and that sentence must reach the tool result;
    // answering the canned endpoint-config hint here sends the reader to
    // debug SPECGUARD_ENDPOINT instead of re-checking WHICH run it named.
    // The SAME sentence answers a foreign id and an unknown one, by design:
    // the two refusals are indistinguishable, so an id enumeration learns
    // nothing.
    await rejects(
      removeRepositoryRun.run(
        { repository_id: "42", run_id: "999" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 404,
            body: JSON.stringify({
              error: "not_found",
              message: "No run with that id belongs to this repository.",
            }),
          }).fetch,
        }),
      ),
      /No run with that id belongs to this repository\./,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The run-delete answers BOTH key kinds through the same `:repo_delete`
    // gate the repository delete does — an agent key holding `repo.delete` on
    // a repository in its own set deletes a run of it. Nothing on the wire
    // changes beyond the Bearer: same DELETE, same path, same empty 204.
    const http = stubFetch(NO_CONTENT);

    await removeRepositoryRun.run(
      { repository_id: "42", run_id: "7" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "DELETE");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/runs/7");
    assert.equal(request?.body, undefined, "a DELETE carries no body");
    assert.equal(request?.headers["authorization"], "Bearer sga_test");
  });

  it("prefers the agent key when BOTH credentials are set", async () => {
    // Scope consistency, not preference: the agent set is what
    // `list_repositories` reports and what the other agent-keyed tools answer
    // inside, so an answer from the person's wider set could name something
    // the agent's own discovery never showed. Asserted ONCE per tool — the
    // precedence is the helper's (`config.ts`), not this tool's behavior to
    // re-prove.
    const http = stubFetch(NO_CONTENT);

    await removeRepositoryRun.run(
      { repository_id: "42", run_id: "7" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("names BOTH variables when only the repository key is set", async () => {
    const http = stubFetch(NO_CONTENT);

    const error = await rejects(
      removeRepositoryRun.run(
        { repository_id: "42", run_id: "7" },
        toolContext({
          env: { SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_test" },
          fetch: http.fetch,
        }),
      ),
      /SPECGUARD_USER_API_KEY or SPECGUARD_AGENT_API_KEY is not set/,
    );

    // The one-message rule at double width: this tool accepts EITHER
    // credential, so refusing with a single name would send the operator to
    // fix a variable, re-call, and be told about the other. The prefixes ride
    // the same sentence — and no mention of the `sgk_` variable they DID set,
    // which is correct and is not the problem.
    assert.match(error.message, /sgu_… key/);
    assert.match(error.message, /sga_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY is not set/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });
});
