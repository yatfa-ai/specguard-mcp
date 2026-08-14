import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as entrypoint from "../src/index.js";
import * as errors from "../src/errors.js";
import { SpecGuardMcpError } from "../src/errors.js";

/**
 * The package entrypoint re-exports the error taxonomy as a hand-written list
 * (`src/index.ts`), and `package.json` points `main`/`types` at it — so that one
 * line IS the taxonomy as far as a consumer is concerned. A class that exists in
 * `errors.ts` but is missing from it is typed and unnameable: the only way to
 * identify the failure is to string-sniff `error.name`, which is exactly the
 * structural check the taxonomy exists to provide.
 *
 * That is a hand-maintained list with one missing cell, and it went unnoticed
 * once already — `ArgumentError` (SPGD-470) shipped its class, its five throw
 * sites and its observer tests without ever reaching this line, because no test
 * imported the entrypoint at all.
 *
 * So this is derived from `errors.ts` rather than restated from it. Adding a
 * sibling class and forgetting the re-export fails here, without anyone
 * remembering to extend this file.
 */
describe("the package entrypoint", () => {
  const taxonomy = Object.entries(errors).filter(
    (entry): entry is [string, typeof SpecGuardMcpError] => {
      const value = entry[1];
      return (
        typeof value === "function" &&
        (value === SpecGuardMcpError || value.prototype instanceof SpecGuardMcpError)
      );
    },
  );

  it("finds a taxonomy to check — a probe over an empty list proves nothing", () => {
    // Guards the derivation itself: if the filter above ever stops matching
    // (a refactor to factory functions, say), every assertion below would pass
    // vacuously and the missing cell would be invisible again.
    assert.ok(taxonomy.length >= 4, `only found ${taxonomy.length} error classes in errors.ts`);
  });

  for (const [name, errorClass] of taxonomy) {
    it(`re-exports ${name}, so a consumer can write \`instanceof ${name}\``, () => {
      const exported = (entrypoint as Record<string, unknown>)[name];

      assert.ok(
        exported !== undefined,
        `${name} extends SpecGuardMcpError but is missing from src/index.ts, so it can only be caught by string-sniffing error.name or by deep-importing past the entrypoint`,
      );
      // Identity, not merely presence: two distinct class objects for the same
      // name would make `instanceof` silently false at the boundary.
      assert.equal(exported, errorClass);
    });
  }
});
