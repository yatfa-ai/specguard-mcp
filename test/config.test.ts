import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LINT_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS,
  loadConfig,
  requireApiConfig,
  tokenise,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("loadConfig", () => {
  it("never throws on an empty environment, so the server always starts", () => {
    const config = loadConfig({});

    assert.equal(config.endpoint, undefined);
    assert.equal(config.apiKey, undefined);
    assert.deepEqual(config.lintCommand, DEFAULT_LINT_COMMAND);
    assert.equal(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("reads SPECGUARD_ENDPOINT, the name the shipped gem already uses", () => {
    assert.equal(loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com" }).endpoint, "https://sg.example.com");
  });

  it("accepts SPECGUARD_URL, the spelling the SPGD-310 brief uses", () => {
    assert.equal(loadConfig({ SPECGUARD_URL: "https://sg.example.com" }).endpoint, "https://sg.example.com");
  });

  it("prefers SPECGUARD_ENDPOINT when both are set and disagree", () => {
    const config = loadConfig({
      SPECGUARD_ENDPOINT: "https://gem.example.com",
      SPECGUARD_URL: "https://brief.example.com",
    });

    assert.equal(config.endpoint, "https://gem.example.com");
  });

  it("strips a trailing slash so joined paths never double up", () => {
    assert.equal(loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com///" }).endpoint, "https://sg.example.com");
  });

  it("treats a blank value as unset, so a turned-off key never becomes a 401", () => {
    const config = loadConfig({ SPECGUARD_API_KEY: "   ", SPECGUARD_ENDPOINT: "" });

    assert.equal(config.apiKey, undefined);
    assert.equal(config.endpoint, undefined);
  });

  it("takes the lint command from SPECGUARD_LINT_COMMAND", () => {
    assert.deepEqual(loadConfig({ SPECGUARD_LINT_COMMAND: "bundle exec specguard-lint" }).lintCommand, [
      "bundle",
      "exec",
      "specguard-lint",
    ]);
  });

  it("ignores a non-positive or unparseable timeout rather than adopting it", () => {
    for (const value of ["0", "-5", "banana", "1.5"]) {
      assert.equal(loadConfig({ SPECGUARD_TIMEOUT_MS: value }).requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    }

    assert.equal(loadConfig({ SPECGUARD_TIMEOUT_MS: "5000" }).requestTimeoutMs, 5000);
  });
});

describe("requireApiConfig", () => {
  it("returns both halves when both are set", () => {
    const api = requireApiConfig(
      loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_abc" }),
    );

    assert.equal(api.endpoint, "https://sg.example.com");
    assert.equal(api.apiKey, "sgk_abc");
  });

  it("names EVERY missing variable in one message, not one per round trip", () => {
    assert.throws(
      () => requireApiConfig(loadConfig({})),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /SPECGUARD_ENDPOINT/);
        assert.match(error.message, /SPECGUARD_API_KEY/);
        return true;
      },
    );
  });

  it("names only the half that is missing", () => {
    assert.throws(
      () => requireApiConfig(loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com" })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        // The accusation clause names one variable; the guidance sentence that
        // follows explains both, which is what makes the message actionable.
        assert.match(error.message, /and SPECGUARD_API_KEY is not set/);
        assert.doesNotMatch(error.message, /SPECGUARD_ENDPOINT and/);
        return true;
      },
    );
  });
});

describe("tokenise", () => {
  it("splits on whitespace", () => {
    assert.deepEqual(tokenise("bundle exec specguard-lint"), ["bundle", "exec", "specguard-lint"]);
  });

  it("keeps a quoted path with spaces in one token", () => {
    assert.deepEqual(tokenise('"/opt/my tools/lint" --flag'), ["/opt/my tools/lint", "--flag"]);
    assert.deepEqual(tokenise("'/opt/my tools/lint'"), ["/opt/my tools/lint"]);
  });

  it("preserves an empty quoted argument rather than dropping it", () => {
    assert.deepEqual(tokenise('lint ""'), ["lint", ""]);
  });

  it("collapses runs of whitespace and returns [] for nothing", () => {
    assert.deepEqual(tokenise("  a \t b \n "), ["a", "b"]);
    assert.deepEqual(tokenise(undefined), []);
    assert.deepEqual(tokenise("   "), []);
  });
});
