import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOLS } from "../../src/tools/index.js";

/**
 * The properties EVERY registry entry must satisfy — asserted over whatever the
 * array holds rather than over the two tools that are in it today.
 *
 * This is the test half of SPGD-310's "adding a tool later must not
 * re-architect the server". A tool added in six months is checked by these
 * assertions without anyone remembering to extend them, which is the only
 * version of that guarantee that survives the people who wrote it.
 */
describe("the tool registry", () => {
  it("is not empty — a bootstrap that wraps nothing is not a bootstrap", () => {
    assert.ok(TOOLS.length > 0);
  });

  it("gives every tool a unique name", () => {
    const names = TOOLS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, `duplicate tool name in ${names.join(", ")}`);
  });

  for (const tool of TOOLS) {
    describe(tool.name, () => {
      it("uses a name an MCP client will accept verbatim", () => {
        assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
      });

      it("has a title", () => {
        assert.ok(tool.title.trim().length > 0);
      });

      it("has a description substantial enough to choose by", () => {
        // The description is prompt material, not documentation: it is the
        // entire basis on which a model decides whether to call the tool.
        assert.ok(
          tool.description.trim().length >= 80,
          `${tool.name}'s description is too thin for a model to select on`,
        );
      });

      it("advertises a closed object schema", () => {
        assert.equal(tool.inputSchema.type, "object");
        // Closed, so a misspelled argument is rejected by the client rather
        // than silently ignored here — a dropped `changed: true` would lint the
        // whole suite and report it clean.
        assert.equal(tool.inputSchema["additionalProperties"], false);
      });

      it("describes every property it accepts", () => {
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;

        for (const [name, schema] of Object.entries(properties)) {
          assert.ok(
            (schema.description ?? "").trim().length > 0,
            `${tool.name}.${name} has no description, so an agent must guess what to pass`,
          );
        }
      });

      it("is callable", () => {
        assert.equal(typeof tool.run, "function");
      });
    });
  }

  it("wraps only capabilities that are shipped today", () => {
    // The standing rule from SPGD-310: a tool in tools/list is a promise an
    // agent will act on, and one that discovers cleanly then fails on use is
    // worse than one that is absent — so nothing may wrap an endpoint that has
    // not shipped. `/check-intent` is still in that state:
    // `specguard/config/routes.rb:113` carries it as a comment only.
    //
    // Duplicate clustering was once under this same forbid and no longer is:
    // SPGD-703 (`specguard` `c43dc19`) shipped
    // `GET /api/v1/repository?near_duplicates=`, which `near_duplicate_clusters`
    // wraps — a name carrying `duplicate`/`cluster` is now evidence of a SHIPPED
    // capability, and this list must not fail it again.
    const forbidden = ["check_intent", "check-intent"];

    for (const tool of TOOLS) {
      for (const term of forbidden) {
        assert.ok(
          !tool.name.includes(term),
          `${tool.name} looks like it wraps a capability that does not exist yet`,
        );
      }
    }
  });
});
