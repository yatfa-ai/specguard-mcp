import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ArgumentError } from "../../src/errors.js";
import {
  optionalBoolean,
  optionalPositiveInteger,
  optionalStringArray,
  requireStringArray,
} from "../../src/tools/args.js";

describe("optionalBoolean", () => {
  it("treats null and undefined as absent rather than refusing them", () => {
    assert.equal(optionalBoolean(null, "changed"), undefined);
    assert.equal(optionalBoolean(undefined, "changed"), undefined);
  });

  it("passes true and false through, false being a value and not an absence", () => {
    assert.equal(optionalBoolean(true, "changed"), true);
    assert.equal(optionalBoolean(false, "changed"), false);
  });
});

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

describe("requireStringArray — absence versus wrong shape", () => {
  for (const [label, value] of [
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    it(`reports ${label} as missing, not as a wrong shape`, () => {
      assert.throws(
        () => requireStringArray(value, "permissions"),
        (error: unknown) => error instanceof ArgumentError && error.message === "`permissions` is required.",
      );
    });
  }
});
