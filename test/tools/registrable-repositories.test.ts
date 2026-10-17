import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import registrableRepositories from "../../src/tools/registrable-repositories.js";
import { rejects, stubFetch, toolContext } from "../support/stubs.js";

/** Only the USER key — the environment an operator who wants just this tool has. */
const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/** Only the REPOSITORY key — refused by design before any table is read. */
const REPOSITORY_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_API_KEY: "sgk_test",
};

/**
 * The body `Api::V1::UserRepositoriesController#registrable` serves, shaped as
 * that controller renders it: `repositories` (each entry `full_name` and
 * `registered`, globally asked) and the derived `grant` block.
 *
 * The fixture carries BOTH values of `registered` — an all-`false` fixture would
 * let a bridge that dropped or defaulted the flag still pass, and the flag is
 * the whole point of this surface: `registered: true` is the answer to "why did
 * my POST say has already been taken", including for a repository somebody ELSE
 * registered.
 */
const BODY = JSON.stringify({
  repositories: [
    { full_name: "acme/app", registered: true },
    { full_name: "acme/billing", registered: false },
  ],
  grant: { captured_at: "2026-08-20T10:00:00Z", expires_at: "2026-08-27T10:00:00Z", stale: false },
});

describe("registrable_repositories", () => {
  it("asks the registrable endpoint, with the user key and no arguments on the wire", async () => {
    const http = stubFetch({ body: BODY });

    await registrableRepositories.run({}, toolContext({ env: USER_ENV, fetch: http.fetch }));

    const request = http.requests[0];
    assert.equal(request?.url, "https://sg.example.com/api/v1/repositories/registrable");
    assert.equal(request?.headers["authorization"], "Bearer sgu_test");
  });

  it("passes the deployment's body back unmodified, repositories and grant alike", async () => {
    // `deepEqual` against the PARSED fixture rather than a hand-listed subset:
    // this bridge is a thin client, so a field added upstream must reach the
    // agent without a release here, and any reshaping — recomputing `stale`,
    // re-deriving `expires_at`, dropping `grant` — has to fail rather than be
    // reported as a nicer answer. Client-side re-derivation of staleness is a
    // second, drifting copy of `MAX_AGE`, and the ticket forbids it.
    const result = await registrableRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(result.structured, JSON.parse(BODY));

    const entry = (result.structured?.["repositories"] as Record<string, unknown>[])[0];
    assert.deepEqual(Object.keys(entry ?? {}).sort(), ["full_name", "registered"]);
    assert.deepEqual(Object.keys(result.structured?.["grant"] as object).sort(), [
      "captured_at",
      "expires_at",
      "stale",
    ]);
  });

  it("renders the same object it returns, so the two cannot disagree", async () => {
    const result = await registrableRepositories.run(
      {},
      toolContext({ env: USER_ENV, fetch: stubFetch({ body: BODY }).fetch }),
    );

    assert.deepEqual(JSON.parse(result.text), result.structured);
  });

  it("refuses a JSON body that is not an object", async () => {
    await rejects(
      registrableRepositories.run(
        {},
        toolContext({ env: USER_ENV, fetch: stubFetch({ body: "[]" }).fetch }),
      ),
      /not an object/,
    );
  });
});

/**
 * The credential seam, in the direction this tool cares about: `registrable`
 * reads the `sgu_` key, and the `sgk_` repository key is refused 401 by design
 * before any table is read. Named in THIS file so a future refactor collapsing
 * the two slots back into one fails here rather than at the deployment.
 */
describe("registrable_repositories reads the user credential", () => {
  it("names the USER variable when only the repository key is set", async () => {
    const http = stubFetch({ body: BODY });

    const error = await rejects(
      registrableRepositories.run({}, toolContext({ env: REPOSITORY_ENV, fetch: http.fetch })),
      /SPECGUARD_USER_API_KEY is not set/,
    );

    assert.match(error.message, /sgu_… key/);
    assert.doesNotMatch(error.message, /SPECGUARD_API_KEY/);
    assert.equal(http.requests.length, 0, "no request should be made without the credential");
  });

  it("reports both missing halves in one sentence rather than one per round trip", async () => {
    const error = await rejects(
      registrableRepositories.run({}, toolContext({ env: {} })),
      /SPECGUARD_ENDPOINT and SPECGUARD_USER_API_KEY are not set/,
    );
  });
});

/**
 * The tool's whole agent-facing contract is prose: the `description` and the README section. The
 * wire tests above pin nothing an agent reads, so these pin the clauses it ACTS on — each on BOTH
 * surfaces, because the README states them independently and `readme.test.ts` checks only structure.
 *
 * The README section is sliced from its heading to the next `### `; `**` emphasis is dropped and
 * whitespace collapsed (the README wraps lines mid-sentence) so assertions are line-wrap-proof.
 */
describe("registrable_repositories — the operative prose is pinned on the description AND the README", () => {
  const HEADING = "### `registrable_repositories`";
  const collapse = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ");

  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf(HEADING);
  const end = start === -1 ? -1 : readme.indexOf("\n### ", start + HEADING.length);
  const section = collapse(start === -1 ? "" : readme.slice(start, end === -1 ? undefined : end));
  const d = collapse(registrableRepositories.description);

  it("positive control: the README section is located by its heading and is non-empty", () => {
    assert.notEqual(start, -1, `README.md has no ${HEADING} heading`);
    assert.match(section, /could register with SpecGuard/);
    assert.ok(section.length > 1500, "the README section is suspiciously short");
  });

  it("pins the entry shape: each entry carries `full_name` and `registered`", () => {
    assert.match(d, /Each entry carries `full_name` and `registered`/);
    assert.match(section, /each entry carrying `full_name` and `registered`/);
  });

  it("pins that `registered` is asked GLOBALLY and entries are marked, not excluded", () => {
    assert.match(d, /`registered` is asked GLOBALLY, not just of this person's own repositories/);
    assert.match(d, /registered by SOMEBODY — possibly someone else — and a POST naming it will be refused with `has already been taken`/);
    assert.match(d, /Entries are marked, not excluded/);
    assert.match(section, /`registered` is asked globally, not just of your own repositories/);
    assert.match(section, /registered by \*?somebody\*? — possibly someone else — and a POST naming it will be refused with `has already been taken`/);
    assert.match(section, /entries are \*?marked\*? rather than excluded/);
  });

  it("pins the grant block's keys and that a missing or stale grant answers 403", () => {
    assert.match(d, /`grant` block \(`captured_at`, `expires_at`, `stale`\)/);
    assert.match(d, /A MISSING or STALE grant is not an error/);
    assert.match(d, /the call then answers 403 with SpecGuard's own sentence naming the fix/);
    assert.match(section, /`grant` block \(`captured_at`, `expires_at`, `stale`\)/);
    assert.match(section, /A missing or stale grant is not an error/);
    assert.match(section, /answers `403` with SpecGuard's own sentence naming the fix/);
  });

  it("pins the grant branch: null means there never was one, stale: true means it lapsed", () => {
    assert.match(d, /`grant: null` means there never was one \(first-time setup\)/);
    assert.match(d, /a populated grant with `stale: true` means an existing connection lapsed/);
    assert.match(d, /branch on it before telling the person what to do/);
    assert.match(section, /`grant: null` means there never was one \(first-time setup\)/);
    assert.match(section, /a populated grant with `stale: true` means an existing connection lapsed/);
    assert.match(section, /Read it before telling the person what to do/);
  });

  it("pins that a listed name is not a promise the write will succeed", () => {
    assert.match(d, /A name appearing in the list is not a promise the write will succeed: someone may register it between this read and the POST/);
    assert.match(section, /A name appearing here is not a promise the write will succeed/);
    assert.match(section, /registered by someone else between this call and your POST/);
  });

  it("pins the ordering: `full_name` ascending, stable across calls", () => {
    assert.match(d, /Ordered by `full_name` ascending, which is stable across calls/);
    assert.match(section, /ordered by `full_name` ascending/);
  });

  it("pins the credential contrast: the sgu_ person key, which list_repositories accepts but does not require, and not the sgk_ key", () => {
    assert.match(d, /Needs SPECGUARD_USER_API_KEY \(an sgu_… key\) — a PERSON key/);
    assert.match(d, /which `list_repositories` also accepts but does not require/);
    assert.match(d, /a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses/);
    assert.match(section, /It reads `SPECGUARD_USER_API_KEY` \(`sgu_…`\)/);
    assert.match(section, /a different one from the `sgk_…` key `get_repository_overview` uses/);
    assert.match(section, /`list_repositories` also accepts that key but does not require it/);
  });

  it("pins that the tool takes no arguments", () => {
    assert.match(section, /This tool takes no arguments/);
    assert.match(section, /The endpoint takes no parameters/);
  });
});
