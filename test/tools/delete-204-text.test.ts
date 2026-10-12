import assert from "node:assert/strict";
import { describe, it } from "node:test";
import removeRepository from "../../src/tools/remove-repository.js";
import removeRepositoryMember from "../../src/tools/remove-repository-member.js";
import revokeRepositoryApiKey from "../../src/tools/revoke-repository-api-key.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import { stubFetch, toolContext } from "../support/stubs.js";

const USER_ENV = {
  SPECGUARD_ENDPOINT: "https://sg.example.com",
  SPECGUARD_USER_API_KEY: "sgu_test",
};

/**
 * The three DELETE tools build `text` as `body === "" ? <sentence> : body`.
 * The sibling specs only assert `notEqual(text, "")`, so neither the whole
 * sentence (the `(204)` marker, the id interpolation, every clause) nor the
 * non-empty-body passthrough arm is pinned anywhere else.
 */
const CASES: ReadonlyArray<{
  tool: ToolDefinition;
  args: Record<string, unknown>;
  sentence: string;
}> = [
  {
    tool: removeRepository,
    args: { repository_id: "42" },
    sentence: "Repository removed (204). Every key, run and intent on it is deleted.",
  },
  {
    tool: removeRepositoryMember,
    args: { repository_id: "42", member_id: "7" },
    sentence:
      "Membership 7 revoked (204). That person's minted CI keys on this repository keep " +
      "authenticating — revoke those separately with revoke_repository_api_key if that is the intent.",
  },
  {
    tool: revokeRepositoryApiKey,
    args: { repository_id: "42", key_id: "9" },
    sentence: "Key 9 revoked (204). Other keys on the repository keep authenticating.",
  },
];

for (const { tool, args, sentence } of CASES) {
  describe(`${tool.name} success text`, () => {
    it("renders the whole literal sentence for an empty 204", async () => {
      const result = await tool.run(
        args,
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 204, body: "" }).fetch }),
      );

      assert.equal(result.text, sentence);
    });

    it("returns a non-empty 2xx body verbatim instead of the sentence", async () => {
      const body = '{"agent_key":{"revoked_at":"2026-01-01T00:00:00Z"}}';
      const result = await tool.run(
        args,
        toolContext({ env: USER_ENV, fetch: stubFetch({ status: 200, body }).fetch }),
      );

      assert.equal(result.text, body);
    });
  });
}
