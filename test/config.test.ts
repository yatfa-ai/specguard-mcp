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

  /**
   * The intersection of the two rules above, and the one input on which they
   * used to disagree.
   *
   * "Blank is unset" decided WHICH variable was in play, but the value was read
   * with `??`, which only falls through on null/undefined — so a blank
   * `SPECGUARD_ENDPOINT` returned the empty string and the alias was never
   * consulted. The operator had set a perfectly good endpoint and was told the
   * endpoint was unset: the exact silent no-op the alias exists to prevent, hit
   * by the person who followed the brief's `SPECGUARD_URL` spelling. A templated
   * client `env` block with every key present and only some filled in is the
   * ordinary way to produce it.
   */
  it("falls through to SPECGUARD_URL when SPECGUARD_ENDPOINT is present but blank", () => {
    for (const blank of ["", "   "]) {
      const config = loadConfig({ SPECGUARD_ENDPOINT: blank, SPECGUARD_URL: "https://brief.example.com" });

      assert.equal(config.endpoint, "https://brief.example.com", `blank ${JSON.stringify(blank)} suppressed the alias`);
      assert.equal(config.endpointVariable, "SPECGUARD_URL");
    }
  });

  it("reports the variable it actually read the endpoint from", () => {
    assert.equal(loadConfig({ SPECGUARD_ENDPOINT: "https://a.example.com" }).endpointVariable, "SPECGUARD_ENDPOINT");
    assert.equal(loadConfig({ SPECGUARD_URL: "https://a.example.com" }).endpointVariable, "SPECGUARD_URL");
    assert.equal(loadConfig({}).endpointVariable, undefined);
  });

  /**
   * The value and its name are read from ONE decision, so they cannot drift
   * apart again — whichever variable `endpointVariable` names is the variable
   * `endpoint` was taken from, for every combination of set/blank/unset.
   */
  it("never names one variable while holding the other's value", () => {
    const values = [undefined, "", "   ", "https://endpoint.example.com"];

    for (const endpointValue of values) {
      for (const urlValue of values) {
        const env: NodeJS.ProcessEnv = {};
        if (endpointValue !== undefined) env["SPECGUARD_ENDPOINT"] = endpointValue;
        if (urlValue !== undefined) env["SPECGUARD_URL"] = urlValue === "https://endpoint.example.com" ? "https://url.example.com" : urlValue;

        const config = loadConfig(env);
        const where = JSON.stringify(env);

        if (config.endpointVariable === undefined) {
          assert.equal(config.endpoint, undefined, `named nothing but held a value: ${where}`);
        } else {
          assert.equal(config.endpoint, env[config.endpointVariable]?.trim(), `name and value disagree: ${where}`);
        }
      }
    }
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

  it("carries WHICH variable the endpoint came from, for the messages downstream", () => {
    const viaAlias = requireApiConfig(
      loadConfig({ SPECGUARD_URL: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_abc" }),
    );

    assert.equal(viaAlias.endpointVariable, "SPECGUARD_URL");
    assert.equal(
      requireApiConfig(loadConfig({ SPECGUARD_ENDPOINT: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_abc" }))
        .endpointVariable,
      "SPECGUARD_ENDPOINT",
    );
  });

  it("uses the alias rather than refusing when SPECGUARD_ENDPOINT is set but blank", () => {
    // The blocking half of the bug: this used to throw "SPECGUARD_ENDPOINT is
    // not set" at an operator who had set SPECGUARD_URL correctly.
    const api = requireApiConfig(
      loadConfig({ SPECGUARD_ENDPOINT: "  ", SPECGUARD_URL: "https://sg.example.com", SPECGUARD_API_KEY: "sgk_abc" }),
    );

    assert.equal(api.endpoint, "https://sg.example.com");
    assert.equal(api.endpointVariable, "SPECGUARD_URL");
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

  it("speaks the operator's spelling in the guidance, not the canonical one", () => {
    assert.throws(
      () => requireApiConfig(loadConfig({ SPECGUARD_URL: "https://sg.example.com" })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /SPECGUARD_URL is your deployment's root URL/);
        assert.doesNotMatch(error.message, /SPECGUARD_ENDPOINT/);
        return true;
      },
    );
  });

  it("asks for SPECGUARD_ENDPOINT when neither spelling was set", () => {
    // Nobody chose a spelling, so the message picks the one the rest of the
    // toolchain (the shipped gem) already reads.
    assert.throws(
      () => requireApiConfig(loadConfig({ SPECGUARD_API_KEY: "sgk_abc" })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /SPECGUARD_ENDPOINT is not set/);
        return true;
      },
    );
  });
});

/**
 * The endpoint is validated where it is REQUIRED, not where it is spent.
 *
 * Unvalidated, a malformed endpoint reaches `new URL(...)` in the HTTP client and
 * throws a `TypeError`, which is not a `SpecGuardMcpError` — so the server's
 * error boundary classifies it as a defect and answers the agent with "this is a
 * bug in the bridge, not in your project or configuration". For a missing
 * `https://` that is the opposite of the truth, and it sends the agent looking in
 * the one place the fault is not. These tests pin the two shapes an operator
 * actually types.
 */
describe("requireApiConfig — a malformed endpoint is a config error, not a bridge bug", () => {
  const key = { SPECGUARD_API_KEY: "sgk_abc" };

  function refusal(env: NodeJS.ProcessEnv): ConfigError {
    try {
      requireApiConfig(loadConfig({ ...key, ...env }));
    } catch (error) {
      assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
      return error;
    }

    return assert.fail("expected a ConfigError");
  }

  it("refuses an endpoint with no scheme — the commonest typo there is", () => {
    const error = refusal({ SPECGUARD_ENDPOINT: "sg.example.com" });

    assert.match(error.message, /SPECGUARD_ENDPOINT is not a usable URL: "sg\.example\.com"/);
    assert.match(error.message, /including the scheme/);
    // The half that matters: it must not disown the problem.
    assert.doesNotMatch(error.message, /bug in the bridge/);
  });

  it("refuses a scheme-less host:port, which `new URL` otherwise accepts as a protocol", () => {
    // `new URL("localhost:3000")` parses — protocol "localhost:", path "3000" —
    // so presence-plus-parse is not enough; the scheme has to be http(s).
    const error = refusal({ SPECGUARD_ENDPOINT: "localhost:3000" });

    assert.match(error.message, /not a usable URL: "localhost:3000"/);
    assert.match(error.message, /http:\/\/localhost:3000/);
  });

  it("refuses a non-HTTP scheme", () => {
    assert.match(refusal({ SPECGUARD_ENDPOINT: "ftp://sg.example.com" }).message, /not a usable URL/);
    assert.match(refusal({ SPECGUARD_ENDPOINT: "file:///etc/passwd" }).message, /not a usable URL/);
  });

  it("names SPECGUARD_URL when THAT is the variable the operator set", () => {
    // Accepting two spellings is only a kindness if the diagnostics speak the
    // one that was used — otherwise it says to fix a variable nobody set.
    const error = refusal({ SPECGUARD_URL: "sg.example.com" });

    assert.match(error.message, /SPECGUARD_URL is not a usable URL/);
    assert.doesNotMatch(error.message, /SPECGUARD_ENDPOINT is not a usable URL/);
  });

  it("accepts what a real deployment looks like, http or https, with a port or a path", () => {
    for (const endpoint of [
      "https://sg.example.com",
      "http://localhost:3000",
      "https://sg.example.com:8443",
      "https://example.com/specguard",
    ]) {
      assert.equal(requireApiConfig(loadConfig({ ...key, SPECGUARD_ENDPOINT: endpoint })).endpoint, endpoint);
    }
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
