import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ArgumentError } from "../../src/errors.js";
import {
  optionalPositiveInteger,
  optionalStringArray,
  requireStringArray,
} from "../../src/tools/args.js";

describe("optionalPositiveInteger", () => {
  it("accepts 1, the lowest legal value", () => {
    assert.equal(optionalPositiveInteger(1, "limit"), 1);
  });
});

describe("optionalStringArray", () => {
  it("trims each entry", () => {
    assert.deepEqual(optionalStringArray([" view ", "\tkeys.manage\n"], "permissions"), [
      "view",
      "keys.manage",
    ]);
  });

  it("refuses a non-string entry rather than coercing it", () => {
    assert.throws(
      () => optionalStringArray(["view", 7], "permissions"),
      (error: unknown) =>
        error instanceof ArgumentError && error.message === "`permissions` must contain only strings.",
    );
  });
});

describe("requireStringArray", () => {
  it("trims each entry", () => {
    assert.deepEqual(requireStringArray([" view ", "\tkeys.manage\n"], "permissions"), [
      "view",
      "keys.manage",
    ]);
  });

  it("drops blank and whitespace-only entries", () => {
    assert.deepEqual(requireStringArray(["view", "", "   ", "keys.manage"], "permissions"), [
      "view",
      "keys.manage",
    ]);
    assert.deepEqual(requireStringArray(["", "  "], "permissions"), []);
  });

  it("refuses a non-string entry rather than coercing it", () => {
    assert.throws(
      () => requireStringArray(["view", 7], "permissions"),
      (error: unknown) =>
        error instanceof ArgumentError && error.message === "`permissions` must contain only strings.",
    );
  });
});
