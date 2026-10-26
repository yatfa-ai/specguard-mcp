import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import listRepositoryAgentKeysPresentedRevoked from "../../src/tools/list-repository-agent-keys-presented-revoked.js";
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

/**
 * The 200 body `user_repository_agent_keys_controller#presented_revoked`
 * serves: `{agent_keys: [row]}`, one row per revoked key whose token is still
 * arriving — `revoked_at` and `last_refused_at` ride every row.
 */
const BODY = JSON.stringify({
  agent_keys: [
    {
      id: 9,
      name: "automation",
      owner: "Ada Lovelace",
      token_hint: "sga_a1b2…",
      repository_count: 3,
      revoked_at: "2026-09-10T09:00:00Z",
      last_refused_at: "2026-09-11T11:58:00Z",
    },
  ],
});

/** The EMPTY answer — "nothing is still arriving" — is a 200 body, not an error. */
const EMPTY_BODY = JSON.stringify({ agent_keys: [] });

describe("list_repository_agent_keys_presented_revoked", () => {
  it("issues a GET to the presented_revoked path scoped to the repository", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(
      request?.url,
      "https://sg.example.com/api/v1/repositories/42/agent_keys/presented_revoked",
    );
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("returns the rows UNRESHAPED — revoked_at and last_refused_at ride through", async () => {
    const result = await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.deepEqual(JSON.parse(result.text), result.structured);
    const row = ((result.structured as Record<string, unknown>)[
      "agent_keys"
    ] as unknown[])[0] as Record<string, unknown>;
    assert.equal(row["last_refused_at"], "2026-09-11T11:58:00Z");
  });

  it("passes the EMPTY answer through as an ANSWER — nothing is still arriving, not an absence of tracking", async () => {
    // The endpoint serves the negative deliberately so "no revoked key is
    // still presented" is distinguishable from "the API does not track that".
    // A tool that summarised an empty body into a count of its own would
    // erase exactly that distinction; this pins the pass-through.
    const result = await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: EMPTY_BODY }).fetch }),
    );

    assert.deepEqual(result.structured, { agent_keys: [] });
    assert.deepEqual(JSON.parse(result.text), { agent_keys: [] });
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        {},
        toolContext({ env: USER_ENV, fetch: http.fetch }),
      ),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        { repository_id: "42" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({
            status: 403,
            body: JSON.stringify({
              error: "not_granted",
              message: "You do not have permission to do that on this repository.",
            }),
          }).fetch,
        }),
      ),
      /SpecGuard refused the request \(403\): You do not have permission to do that on this repository\./,
    );
  });

  it("falls back to the generic sentence on a non-conforming 403 body", async () => {
    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        { repository_id: "42" },
        toolContext({
          env: USER_ENV,
          fetch: stubFetch({ status: 403, body: "denied" }).fetch,
        }),
      ),
      /SpecGuard answered 403: denied/,
    );
  });

  it("keeps the 404 branch — the repository-existence fork's own answer", async () => {
    await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The agent-keys endpoints answer BOTH key kinds since SPGD-1004 (`dfb9892`) —
    // the triage is then bounded by the key's own set and its `keys.manage` — so
    // an agent credential can verify its own offboarding. Nothing on the wire
    // changes beyond the Bearer: same GET, same path.
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys/presented_revoked");
    assert.equal(request?.headers["authorization"], "Bearer sga_test");
  });

  it("prefers the agent key when BOTH credentials are set", async () => {
    // Scope consistency, not preference: the agent set is what
    // `list_repositories` reports and what the other agent-keyed tools answer
    // inside, so an answer from the person's wider set could name something
    // the agent's own discovery never showed. Asserted ONCE per tool — the
    // precedence is the helper's (`config.ts`), not this tool's behavior to
    // re-prove.
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeysPresentedRevoked.run(
      { repository_id: "42" },
      toolContext({
        env: { ...USER_ENV, SPECGUARD_AGENT_API_KEY: "sga_test" },
        fetch: http.fetch,
      }),
    );

    assert.equal(http.requests[0]?.headers["authorization"], "Bearer sga_test");
  });

  it("names BOTH variables when only the repository key is set", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    const error = await rejects(
      listRepositoryAgentKeysPresentedRevoked.run(
        { repository_id: "42" },
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

/**
 * The tool's agent-facing contract is prose: the `description`, the
 * `repository_id` argument description and the README section. The wire tests
 * above pin requests, pass-through, 403/404 rendering and credential
 * precedence, but no operative clause an agent acts on is asserted: that
 * `last_refused_at` is a recency and never a present-tense claim, that an empty
 * `{"agent_keys": []}` is an ANSWER and not an absence of tracking, that
 * `token_hint` is what to hunt and never the token, that this is the verify half
 * run after `revoke_repository_agent_key`, `keys_manage` with its 403, and the
 * EITHER-credential rule with the agent set's own 404 bound. A rewording that
 * flips "empty = answer" to "empty = no tracking" would leave the suite green,
 * and `readme.test.ts` checks identifier presence only.
 *
 * The README section is sliced from its heading to the next `### `; `**`
 * emphasis is dropped and whitespace collapsed (the README wraps lines
 * mid-sentence) so assertions are line-wrap-proof.
 */
describe("list_repository_agent_keys_presented_revoked — the operative prose it teaches", () => {
  const HEADING = "### `list_repository_agent_keys_presented_revoked`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(listRepositoryAgentKeysPresentedRevoked.description);
  const repositoryIdArg = collapse(
    (listRepositoryAgentKeysPresentedRevoked.inputSchema.properties as Record<
      string,
      { description?: string } | undefined
    >)["repository_id"]?.description ?? "",
  );

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 800, "the README section is suspiciously short");
  });

  // -- The description's clause families -------------------------------------

  it("description: REVOKED keys whose token is still arriving after revocation — the verify half of offboarding, run after revoke_repository_agent_key", () => {
    assert.match(
      d,
      /Lists REVOKED agent keys whose token is still arriving at the deployment after revocation — the verify half of offboarding: run it after `revoke_repository_agent_key` to learn whether the dead token is still being presented somewhere/,
    );
  });

  it("description: each row carries id, name, owner, token_hint, repository_count, revoked_at and last_refused_at", () => {
    assert.match(
      d,
      /Each row carries `id`, `name`, `owner`, `token_hint` \(.*\), `repository_count`, `revoked_at` and `last_refused_at`/,
    );
  });

  it("description: token_hint is what to HUNT in secret stores that may still hold the dead token, and update them", () => {
    assert.match(
      d,
      /`token_hint` \(hunt THIS in whatever secret stores may still hold the dead token, and update them\)/,
    );
  });

  it("description: last_refused_at is the LAST observed presentation — a recency, never a present-tense claim that something is presenting the token right now", () => {
    assert.match(
      d,
      /`last_refused_at` is the LAST observed presentation — a recency, never a present-tense claim that something is presenting the token right now/,
    );
  });

  it("description: an empty {\"agent_keys\": []} is an ANSWER — nothing is still arriving — not an absence of tracking; the offboarding fully taken", () => {
    assert.match(
      d,
      /An empty `\{"agent_keys": \[\]\}` is an ANSWER — nothing is still arriving — not an absence of tracking; read it as the offboarding having fully taken/,
    );
  });

  it("description: token_hint is a hint, never the token — the plaintext existed for exactly one response at mint time and nothing persisted it", () => {
    assert.match(
      d,
      /`token_hint` is a hint, never the token — the plaintext existed for exactly one response at mint time and nothing persisted it/,
    );
  });

  it("description: authorization is the keys_manage capability — a caller without it is refused 403 in SpecGuard's own words", () => {
    assert.match(
      d,
      /Authorization is the `keys_manage` capability — a caller without it is refused 403 in SpecGuard's own words/,
    );
  });

  it("description: the EITHER-credential rule — SPECGUARD_AGENT_API_KEY when set, SPECGUARD_USER_API_KEY when that is not set", () => {
    assert.match(
      d,
      /It authenticates with EITHER of this server's two key-administration credentials, whichever is set: SPECGUARD_AGENT_API_KEY/,
    );
    assert.match(
      d,
      /and, when that is not set, SPECGUARD_USER_API_KEY \(an sgu_… key, the same credential the other key-administration tools read\)/,
    );
  });

  it("description: a repository outside the agent set answers 404, never a probe here — an agent credential verifying its own offboarding needs no person's sgu_ key", () => {
    assert.match(
      d,
      /a repository outside that set answers 404 in SpecGuard's own words, never a probe here — an agent credential verifying its own offboarding needs no person's `sgu_` key to do it/,
    );
  });

  it("description: with both set the agent key wins, so the triage stays inside the same set list_repositories reports", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the triage stays inside the same set `list_repositories` reports/,
    );
  });

  it("description: a DIFFERENT credential from the sgk_… repository key get_repository_overview uses; SpecGuard refuses each in the other's place", () => {
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses; SpecGuard refuses each in the other's place/,
    );
  });

  // -- The argument description ----------------------------------------------

  it("repository_id argument: the numeric id from add_repository / list_repositories, not the org/repo handle", () => {
    assert.match(
      repositoryIdArg,
      /The repository to triage — its numeric id, as `add_repository` returns and `list_repositories` reports, not the `org\/repo` handle/,
    );
  });

  // -- The README section's copy ----------------------------------------------

  it("README: the verify half of offboarding — run after revoke_repository_agent_key; token_hint is what to hunt", () => {
    assert.match(
      section,
      /the verify half of offboarding\. Run it after `revoke_repository_agent_key` to learn whether the dead token is still being presented somewhere/,
    );
    assert.match(
      section,
      /`token_hint` \(hunt this in whatever secret stores may still hold the dead token, and update them\)/,
    );
  });

  it("README: last_refused_at is the last observed presentation (a recency), and an empty {\"agent_keys\": []} is an answer, not an absence of tracking", () => {
    assert.match(
      section,
      /`last_refused_at` is the last observed presentation — a recency, never a claim that something is presenting the token right now/,
    );
    assert.match(
      section,
      /an empty `\{"agent_keys": \[\]\}` is an answer — nothing is still arriving — not an absence of tracking; read it as the offboarding having fully taken/,
    );
  });

  it("README: token_hint is never the token, keys_manage with a verbatim 403, the agent key wins when both are set, and the sgk_… contrast", () => {
    assert.match(
      section,
      /`token_hint` is a hint, never the token — the plaintext existed for exactly one response at mint time and nothing persisted it/,
    );
    assert.match(
      section,
      /Authorization is the `keys_manage` capability; a caller without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
    assert.match(
      section,
      /With both set the agent key wins, so the triage stays inside the same set `list_repositories` reports/,
    );
    assert.match(section, /a different one from the `sgk_…` key `get_repository_overview` uses/);
    assert.match(
      section,
      /a repository outside that set is answered `404` in SpecGuard's own words, so an agent credential can verify its own offboarding without a person's `sgu_` key/,
    );
  });
});
