import assert from "node:assert/strict";
import { describe, it } from "node:test";
import addRepositoryMember from "../../src/tools/add-repository-member.js";
import createRepositoryApiKey from "../../src/tools/create-repository-api-key.js";
import listRepositoryAgentKeys from "../../src/tools/list-repository-agent-keys.js";
import listRepositoryAgentKeysPresentedRevoked from "../../src/tools/list-repository-agent-keys-presented-revoked.js";
import listRepositoryApiKeys from "../../src/tools/list-repository-api-keys.js";
import listRepositoryMembers from "../../src/tools/list-repository-members.js";
import removeRepository from "../../src/tools/remove-repository.js";
import removeRepositoryMember from "../../src/tools/remove-repository-member.js";
import renameRepository from "../../src/tools/rename-repository.js";
import revokeRepositoryAgentKey from "../../src/tools/revoke-repository-agent-key.js";
import revokeRepositoryApiKey from "../../src/tools/revoke-repository-api-key.js";
import updateRepositoryMemberPermissions from "../../src/tools/update-repository-member-permissions.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { stubFetch, toolContext } from "../support/stubs.js";

/**
 * Every repository-scoped admin tool interpolates agent-supplied ids into the
 * request path through `encodeURIComponent`. Every other spec sends a plain
 * numeric id (`"42"`), for which encoded and raw are byte-identical, so none of
 * them can tell the two apart. These ids are hostile on purpose: raw, `/` adds
 * a path segment and a space corrupts the URL, silently re-aiming a write
 * (revoke, remove, rename) at a different route. `requireString` trims but does
 * not restrict characters, so this is a live path.
 *
 * The shared `repositoryTarget` seam has its own pin (specguard-api.test.ts);
 * this file covers the inline per-tool sites that seam does not reach.
 */

const REPO = "a b/c";
const REPO_SEGMENT = "a%20b%2Fc";
const OTHER = "x y/z";
const OTHER_SEGMENT = "x%20y%2Fz";
const BASE = `https://sg.example.com/api/v1/repositories/${REPO_SEGMENT}`;

const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

interface Row {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  status: number;
  body: string;
  /** The URL the tool must request: every id one encoded path segment. */
  url: string;
}

const ROWS: Row[] = [
  {
    tool: addRepositoryMember,
    args: { repository_id: REPO, handle: "alice" },
    status: 201,
    body: "{}",
    url: `${BASE}/members`,
  },
  {
    tool: createRepositoryApiKey,
    args: { repository_id: REPO },
    status: 201,
    body: "{}",
    url: `${BASE}/api_keys`,
  },
  {
    tool: listRepositoryAgentKeysPresentedRevoked,
    args: { repository_id: REPO },
    status: 200,
    body: "{}",
    url: `${BASE}/agent_keys/presented_revoked`,
  },
  {
    tool: listRepositoryAgentKeys,
    args: { repository_id: REPO },
    status: 200,
    body: "{}",
    url: `${BASE}/agent_keys`,
  },
  {
    tool: listRepositoryApiKeys,
    args: { repository_id: REPO },
    status: 200,
    body: "{}",
    url: `${BASE}/api_keys`,
  },
  {
    tool: listRepositoryMembers,
    args: { repository_id: REPO },
    status: 200,
    body: "{}",
    url: `${BASE}/members`,
  },
  {
    tool: removeRepositoryMember,
    args: { repository_id: REPO, member_id: OTHER },
    status: 204,
    body: "",
    url: `${BASE}/members/${OTHER_SEGMENT}`,
  },
  {
    tool: removeRepository,
    args: { repository_id: REPO },
    status: 204,
    body: "",
    url: BASE,
  },
  {
    tool: renameRepository,
    args: { repository_id: REPO, github_full_name: "octocat/new-name" },
    status: 200,
    body: "{}",
    url: BASE,
  },
  {
    tool: revokeRepositoryAgentKey,
    args: { repository_id: REPO, key_id: OTHER },
    status: 200,
    body: "{}",
    url: `${BASE}/agent_keys/${OTHER_SEGMENT}`,
  },
  {
    tool: revokeRepositoryApiKey,
    args: { repository_id: REPO, key_id: OTHER },
    status: 204,
    body: "",
    url: `${BASE}/api_keys/${OTHER_SEGMENT}`,
  },
  {
    tool: updateRepositoryMemberPermissions,
    args: { repository_id: REPO, member_id: OTHER, permissions: ["view"] },
    status: 200,
    body: "{}",
    url: `${BASE}/members/${OTHER_SEGMENT}`,
  },
];

describe("per-tool path-segment encoding", () => {
  for (const row of ROWS) {
    it(`${row.tool.name} sends each id as one percent-encoded path segment`, async () => {
      const http = stubFetch({ status: row.status, body: row.body });

      await row.tool.run(row.args, toolContext({ env: USER_ENV, fetch: http.fetch }));

      assert.equal(http.requests.length, 1);
      assert.equal(http.requests[0]?.url, row.url);
    });
  }

  it("covers 12 distinct tools, so a new path-building tool must join the table", () => {
    assert.equal(new Set(ROWS.map((row) => row.tool.name)).size, 12);
  });
});
