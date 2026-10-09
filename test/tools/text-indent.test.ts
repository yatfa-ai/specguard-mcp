import assert from "node:assert/strict";
import { describe, it } from "node:test";
import addRepositoryMember from "../../src/tools/add-repository-member.js";
import addRepository from "../../src/tools/add-repository.js";
import createRepositoryApiKey from "../../src/tools/create-repository-api-key.js";
import getServerVersion from "../../src/tools/get-server-version.js";
import listRepositories from "../../src/tools/list-repositories.js";
import listRepositoryAgentKeys from "../../src/tools/list-repository-agent-keys.js";
import listRepositoryAgentKeysPresentedRevoked from "../../src/tools/list-repository-agent-keys-presented-revoked.js";
import listRepositoryApiKeys from "../../src/tools/list-repository-api-keys.js";
import listRepositoryMembers from "../../src/tools/list-repository-members.js";
import registrableRepositories from "../../src/tools/registrable-repositories.js";
import renameRepository from "../../src/tools/rename-repository.js";
import repositoryOverview from "../../src/tools/repository-overview.js";
import revokeRepositoryAgentKey from "../../src/tools/revoke-repository-agent-key.js";
import updateRepositoryMemberPermissions from "../../src/tools/update-repository-member-permissions.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { stubFetch, toolContext } from "../support/stubs.js";

/**
 * Fourteen tools build their MCP `text` content with `JSON.stringify(body, null, 2)`.
 * `text` is the only channel a client that ignores `structuredContent` reads, and
 * every other spec for these tools asserts on `structured` or on a PARSED `text` —
 * a parse cannot tell the two-space document from the one-line one, so dropping the
 * `null, 2` at any single site left the whole suite green.
 *
 * The body is fixed and deliberately nested (an object inside an object, and an
 * array) so a one-space, four-space or tab variant fails too, not only the compact
 * one. The expected string is spelled out literally rather than re-derived with
 * `JSON.stringify`, which would just restate the implementation.
 *
 * Tools that already pin their own layout (near_duplicate_clusters,
 * find_tests_near_behavior, lint_intent_annotations) are out of this table.
 */

const BODY = '{"alpha":{"beta":1},"gamma":[2]}';

const EXPECTED_TEXT = [
  "{",
  '  "alpha": {',
  '    "beta": 1',
  "  },",
  '  "gamma": [',
  "    2",
  "  ]",
  "}",
].join("\n");

// Both credentials, so every tool resolves the one it needs.
const ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_API_KEY: "sgk_test",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

interface Row {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  status: number;
}

const ROWS: Row[] = [
  { tool: addRepository, args: { full_name: "octocat/hello" }, status: 201 },
  { tool: addRepositoryMember, args: { repository_id: "42", handle: "alice" }, status: 201 },
  { tool: createRepositoryApiKey, args: { repository_id: "42" }, status: 201 },
  { tool: getServerVersion, args: {}, status: 200 },
  { tool: listRepositories, args: {}, status: 200 },
  { tool: listRepositoryAgentKeys, args: { repository_id: "42" }, status: 200 },
  { tool: listRepositoryAgentKeysPresentedRevoked, args: { repository_id: "42" }, status: 200 },
  { tool: listRepositoryApiKeys, args: { repository_id: "42" }, status: 200 },
  { tool: listRepositoryMembers, args: { repository_id: "42" }, status: 200 },
  { tool: registrableRepositories, args: {}, status: 200 },
  { tool: renameRepository, args: { repository_id: "42", github_full_name: "octocat/new-name" }, status: 200 },
  { tool: repositoryOverview, args: {}, status: 200 },
  { tool: revokeRepositoryAgentKey, args: { repository_id: "42", key_id: "7" }, status: 200 },
  {
    tool: updateRepositoryMemberPermissions,
    args: { repository_id: "42", member_id: "7", permissions: ["view"] },
    status: 200,
  },
];

describe("result text is the two-space JSON document", () => {
  for (const row of ROWS) {
    it(`${row.tool.name} serialises its body with two-space indentation`, async () => {
      const http = stubFetch({ status: row.status, body: BODY });

      const result = await row.tool.run(row.args, toolContext({ env: ENV, fetch: http.fetch }));

      assert.equal(http.requests.length, 1);
      assert.equal(result.text, EXPECTED_TEXT);
    });
  }

  it("covers 14 distinct tools, so a new pass-through tool must join the table", () => {
    assert.equal(new Set(ROWS.map((row) => row.tool.name)).size, 14);
  });
});
