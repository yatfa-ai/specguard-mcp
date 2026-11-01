import assert from "node:assert/strict";
import { it } from "node:test";

/**
 * Description-clause examples shared by the member-administration tools
 * (add_repository_member, update_repository_member_permissions,
 * remove_repository_member). Each tool's description carries the same
 * boilerplate sentences; pinning them once here keeps the three tests from
 * hand-pasting identical blocks. Call these inside the tool's `describe`, with
 * `d` the tool's collapsed description. Clauses particular to one tool stay in
 * that tool's own test.
 *
 * This is a helper, not a `.test.ts`, so the runner does not execute it directly.
 */

/** The repository_id, EITHER-credential and DIFFERENT-credential clauses, shared by all three tools. */
export function itStatesSharedMemberAdminClauses(d: string): void {
  it("description: repository_id is the numeric id list_repositories reports, not the org/repo handle", () => {
    assert.match(
      d,
      /Takes `repository_id` — the numeric id `list_repositories` reports, not the `org\/repo` handle/,
    );
  });

  it("description: the EITHER-credential rule — the agent key is bounded by its members.manage grants (404, never a probe), the user key is add_repository's", () => {
    assert.match(
      d,
      /It authenticates with EITHER of this server's two member-administration credentials, whichever is set/,
    );
    assert.match(
      d,
      /SPECGUARD_AGENT_API_KEY \(an sga_… key — the call then reaches only the repositories granted onto that key at mint time, and only where the grant carries `members\.manage`; a repository outside that set answers 404 in SpecGuard's own words, never a probe here\)/,
    );
    assert.match(
      d,
      /when that is not set, SPECGUARD_USER_API_KEY \(an sgu_… key, the same credential `add_repository` writes with\)/,
    );
  });

  it("description: a DIFFERENT credential from the sgk_ repository key get_repository_overview uses", () => {
    assert.match(
      d,
      /Either way it is a DIFFERENT credential from the sgk_… repository key `get_repository_overview` uses/,
    );
  });
}

/** The bare members.manage authorization clause (add and update; remove's variant also pins its 204). */
export function itStatesMembersManageAuthorization(d: string): void {
  it("description: authorization is the members.manage capability — a member without it is refused 403 in SpecGuard's own words", () => {
    assert.match(
      d,
      /Authorization is the `members\.manage` capability — a member without it is refused 403 in SpecGuard's own words/,
    );
  });
}
