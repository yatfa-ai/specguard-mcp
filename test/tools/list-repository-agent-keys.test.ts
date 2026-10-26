import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import listRepositoryAgentKeys from "../../src/tools/list-repository-agent-keys.js";
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
 * The 200 body `user_repository_agent_keys_controller#index` serves:
 * `{agent_keys: [row]}`, one row per LIVE key covering the repository —
 * the controller's own serialization, pass-through. Two rows, because the
 * field this fixture exists to carry reads BOTH ways: row 9 was presented
 * minutes ago, row 10 was minted and never presented — its `last_used_at`
 * rides the row as null, the negative served rather than omitted.
 */
const BODY = JSON.stringify({
  agent_keys: [
    {
      id: 9,
      name: "automation",
      owner: "Ada Lovelace",
      token_hint: "sga_a1b2…",
      repository_count: 3,
      permissions: "read only",
      created_at: "2026-09-08T12:00:00Z",
      last_used_at: "2026-09-13T11:58:00Z",
    },
    {
      id: 10,
      name: "minted-never-presented",
      owner: "Ada Lovelace",
      token_hint: "sga_c3d4…",
      repository_count: 1,
      permissions: "read only",
      created_at: "2026-09-12T08:00:00Z",
      last_used_at: null,
    },
  ],
});

describe("list_repository_agent_keys", () => {
  it("issues a GET to the agent_keys index scoped to the repository", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeys.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("returns the body UNRESHAPED — the id an agent needs for the revoke stays where the controller put it", async () => {
    const result = await listRepositoryAgentKeys.run(
      { repository_id: "42" },
      toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body: BODY }).fetch }),
    );

    // `deepEqual` against the parsed fixture, not a hand-listed subset: the
    // listing is the ONLY id source on this bridge (no mint tool exists), so
    // any reshaping that dropped a field could drop the one the revoke needs.
    assert.deepEqual(result.structured, JSON.parse(BODY));
    assert.equal(
      ((result.structured as Record<string, unknown>)["agent_keys"] as unknown[])[0] !== undefined,
      true,
    );
    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("refuses a missing repository_id before anything is sent", async () => {
    const http = stubFetch({ status: 200, body: BODY });

    await rejects(
      listRepositoryAgentKeys.run({}, toolContext({ env: USER_ENV, fetch: http.fetch })),
      /`repository_id` is required/,
    );
    assert.equal(http.requests.length, 0);
  });

  it("surfaces the server's whole 403 sentence when the body conforms", async () => {
    await rejects(
      listRepositoryAgentKeys.run(
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
      listRepositoryAgentKeys.run(
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
      listRepositoryAgentKeys.run(
        { repository_id: "42" },
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 404, body: "" }).fetch }),
      ),
      /has no such endpoint \(404\)|SpecGuard answered 404/,
    );
  });

  it("authenticates with the agent key when that is the only key set", async () => {
    // The agent-keys endpoints answer BOTH key kinds since SPGD-1004 (`dfb9892`) —
    // the read is then bounded by the key's own set and its `keys.manage` — so
    // an agent credential can administer the agent keys covering a repository in
    // its own set, the offboarding arc's own first step. Nothing on the wire
    // changes beyond the Bearer: same GET, same path.
    const http = stubFetch({ status: 200, body: BODY });

    await listRepositoryAgentKeys.run(
      { repository_id: "42" },
      toolContext({ env: AGENT_ENV, fetch: http.fetch }),
    );

    const request = http.requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/42/agent_keys");
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

    await listRepositoryAgentKeys.run(
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
      listRepositoryAgentKeys.run(
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
 * The operative prose this tool teaches — its description, its `repository_id`
 * argument description and its README section — pinned clause by clause, so an
 * edit that softens one (the blast radius, never-presented, list-first, live
 * rows only, a hint never the token, keys_manage + 403, the either-credential
 * rule with its agent 404 bound) turns a NAMED example red instead of passing
 * the wire tests above. Mirrors the `revoke_repository_agent_key` block.
 *
 * The README section is sliced from its heading to the next `### `; `**`
 * emphasis is dropped and whitespace collapsed (the README wraps lines
 * mid-sentence) so assertions are line-wrap-proof.
 */
describe("list_repository_agent_keys — the operative prose it teaches", () => {
  const HEADING = "### `list_repository_agent_keys`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(listRepositoryAgentKeys.description);
  const repositoryIdArg = collapse(
    (listRepositoryAgentKeys.inputSchema.properties as Record<
      string,
      { description?: string } | undefined
    >)["repository_id"]?.description ?? "",
  );

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.ok(section.length > 800, "the README section is suspiciously short");
  });

  // -- The description's clause families -------------------------------------

  it("description: one row per live key, with repository_count as the blast radius — how many repositories the key's grant covers", () => {
    assert.match(d, /one row per live key with its `id`, `name`, `owner`, `token_hint`/);
    assert.match(
      d,
      /`repository_count` \(how many repositories the key's grant covers — the blast radius\)/,
    );
  });

  it("description: last_used_at is when the key's token last authenticated, null meaning the key has never been presented", () => {
    assert.match(
      d,
      /`last_used_at` — when the key's token last authenticated, null meaning the key has never been presented/,
    );
  });

  it("description: the inventory answers \"is this live key still being used\" before a revoke — the decision half of offboarding", () => {
    assert.match(
      d,
      /the inventory answers "is this live key still being used" before a revoke — the decision half of offboarding/,
    );
  });

  it("description: agent keys have NO mint tool on this bridge, so this listing's id is the ONLY way to name a key to revoke_repository_agent_key — list first, then revoke", () => {
    assert.match(
      d,
      /Agent keys have NO mint tool on this bridge — minting is deliberately web-only — so the `id` this listing serves is the ONLY way to name a key to `revoke_repository_agent_key`: list first, then revoke/,
    );
  });

  it("description: revoked keys leave this listing, and whether a dead token is still arriving is list_repository_agent_keys_presented_revoked's question", () => {
    assert.match(
      d,
      /Revoked keys leave this listing \(a retained revoked row is not a credential\); whether a dead token is still arriving is `list_repository_agent_keys_presented_revoked`'s question/,
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

  it("description: a repository outside the agent set answers 404, never a probe here — an agent credential needs no person's sgu_ key; the call reaches only granted repositories where the grant carries keys.manage", () => {
    assert.match(
      d,
      /the call then reaches only the repositories granted onto that key at mint time, and only where the grant carries `keys.manage`; a repository outside that set answers 404 in SpecGuard's own words, never a probe here — an agent credential administering the keys it was granted needs no person's `sgu_` key to do it/,
    );
  });

  it("description: with both set the agent key wins, and it is a DIFFERENT credential from the sgk_… repository key get_repository_overview uses", () => {
    assert.match(
      d,
      /With both set the agent key wins, so the answer stays inside the same set `list_repositories` reports/,
    );
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses; SpecGuard refuses each in the other's place/,
    );
  });

  // -- The argument description ----------------------------------------------

  it("repository_id argument: the numeric id from add_repository / list_repositories, not the org/repo handle", () => {
    assert.match(
      repositoryIdArg,
      /The repository whose agent keys to list — its numeric id, as `add_repository` returns and `list_repositories` reports, not the `org\/repo` handle/,
    );
  });

  // -- The README section's copy ----------------------------------------------

  it("README: one row per live key, with repository_count as the blast radius", () => {
    assert.match(section, /One row per live key: `id`, `name`, `owner`, `token_hint`/);
    assert.match(
      section,
      /`repository_count` \(how many repositories the key's grant covers — the blast radius\)/,
    );
  });

  it("README: last_used_at null means the key has never been presented, so the inventory answers whether a live key is still being used", () => {
    assert.match(
      section,
      /`last_used_at` — when the key's token last authenticated, `null` meaning the key has never been presented, so the inventory answers "is this live key still being used" before you cut anything/,
    );
  });

  it("README: the id here is the only way to name an agent key on this bridge — no mint tool, so list first, then revoke_repository_agent_key", () => {
    assert.match(
      section,
      /The `id` here is the only way to name an agent key on this bridge\. Agent keys have no mint tool — the platform mints them web-only at \/account, deliberately/,
    );
    assert.match(section, /List first, then `revoke_repository_agent_key`/);
  });

  it("README: revoked keys leave this listing, with the presented_revoked pointer; token_hint is a hint, never the token", () => {
    assert.match(
      section,
      /Revoked keys leave this listing \(a retained revoked row is not a credential\); whether a dead token is still arriving is `list_repository_agent_keys_presented_revoked`'s question/,
    );
    assert.match(
      section,
      /`token_hint` is a hint, never the token — the plaintext existed for exactly one response at mint time and nothing persisted it/,
    );
  });

  it("README: the keys_manage 403 verbatim, and the either-credential rule with the agent 404 bound and agent-wins precedence", () => {
    assert.match(
      section,
      /Authorization is the `keys_manage` capability; a caller without it is refused `403` with SpecGuard's own sentence, verbatim/,
    );
    assert.match(
      section,
      /only where the grant carries `keys\.manage` — a repository outside that set is answered `404` in SpecGuard's own words/,
    );
    assert.match(
      section,
      /With both set the agent key wins, so the answer stays inside the same set `list_repositories` reports/,
    );
  });
});
