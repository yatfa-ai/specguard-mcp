import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT_CLOSE_GRACE_MS } from "../../src/support/run-command.js";
import lintIntentAnnotations from "../../src/tools/lint-intent-annotations.js";
import { rejects, stubCommand, toolContext } from "../support/stubs.js";

// `undrainedPipe` is the message an agent reads when the linter exited but
// something it left running kept the stdout pipe open. The sibling tests in
// lint-intent-annotations.test.ts pin that the diagnosis is chosen; these pin
// what it SAYS: the interpolated exit code and grace window, and the two
// appendices (trimmed, capped at 2000 characters, partial document first).
async function undrained(result: { code?: number; stdout?: string; stderr?: string }): Promise<string> {
  const error = await rejects(
    lintIntentAnnotations.run(
      {},
      toolContext({ runCommand: stubCommand({ ...result, outputDrained: false }).runCommand }),
    ),
    /kept the output pipe open/,
  );

  return error.message;
}

const SENTENCE_END = "re-running unchanged will end the same way.";

describe("lint_intent_annotations — held-open-pipe diagnosis wording", () => {
  it("names the real exit code and the grace window the bridge waited", async () => {
    const message = await undrained({ code: 1, stdout: "" });

    assert.ok(
      message.startsWith("specguard-lint exited 1, but this bridge did not receive"),
      `unexpected opening: ${message.slice(0, 80)}`,
    );
    assert.ok(
      message.includes(`reading ${EXIT_CLOSE_GRACE_MS}ms later rather than waiting forever`),
      "the grace window must be interpolated from EXIT_CLOSE_GRACE_MS",
    );
  });

  it("trims both appendices and orders the partial document before stderr", async () => {
    const message = await undrained({
      code: 0,
      stdout: '  \n{"ok":true,"findings":[\n  ',
      stderr: "\n  spring: still running  \n",
    });

    assert.ok(
      message.endsWith(
        'The partial document was:\n{"ok":true,"findings":[\n\nIt reported on stderr:\nspring: still running',
      ),
      `unexpected tail: ${JSON.stringify(message.slice(-160))}`,
    );
  });

  it("omits both appendices when stdout is empty and stderr is only whitespace", async () => {
    const message = await undrained({ code: 0, stdout: "", stderr: " \n\t  \n" });

    assert.doesNotMatch(message, /partial document was/);
    assert.doesNotMatch(message, /reported on stderr/);
    assert.ok(message.endsWith(SENTENCE_END), `unexpected tail: ${JSON.stringify(message.slice(-80))}`);
  });

  it("caps an over-long stderr appendix at 2000 characters with a truncation marker", async () => {
    const message = await undrained({ code: 0, stdout: "", stderr: "e".repeat(2500) });

    assert.ok(
      message.endsWith(`It reported on stderr:\n${"e".repeat(2000)}… [truncated]`),
      `unexpected tail: ${JSON.stringify(message.slice(-60))}`,
    );
  });

  it("caps an over-long partial document at 2000 characters with a truncation marker", async () => {
    const message = await undrained({ code: 0, stdout: `{${"x".repeat(2499)}` });

    assert.ok(
      message.endsWith(`The partial document was:\n{${"x".repeat(1999)}… [truncated]`),
      `unexpected tail: ${JSON.stringify(message.slice(-60))}`,
    );
  });
});
