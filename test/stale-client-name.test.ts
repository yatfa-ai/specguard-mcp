import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The Ruby client gem was renamed `specguard-rspec` -> `specguard-ruby`. The old
 * name is dead on RubyGems (HTTP 404; the gem was yanked), so every mention of
 * it in a published surface sends a reader to a package and a repository that no
 * longer exist. `package.json` ships `files: ["dist", "README.md"]`, so the
 * README is user-facing; the `src` comments are what a maintainer reads when
 * deciding which gem a claim is about.
 *
 * This pins the rename the way `readme.test.ts` pins the argument tables: no
 * test used to open these files, so the stale name came back unnoticed.
 *
 * Deliberately NOT scanned: `.github/workflows/release.yml` and
 * `script/bump-version.sh` ("Mirrors/Ported from specguard-rspec's ..."), which
 * record where code was ported FROM and are historical provenance, not claims
 * about the current gem.
 */
const STALE_NAME = "specguard-rspec";

// Compiled to `.test-build/test/`, so the repo root is two levels up — the same
// convention `readme.test.ts` uses for README.md.
const ROOT = new URL("../../", import.meta.url);

function tsFilesUnder(dir: URL): URL[] {
  const found: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...tsFilesUnder(new URL(`${entry.name}/`, dir)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(new URL(entry.name, dir));
    }
  }
  return found;
}

describe("stale Ruby-client name", () => {
  it(`has no \`${STALE_NAME}\` in README.md or src/**/*.ts`, () => {
    const files = [new URL("README.md", ROOT), ...tsFilesUnder(new URL("src/", ROOT))];
    assert.ok(
      files.length > 1,
      "found no src/**/*.ts files, so this pin would be checking nothing — the path to src/ is wrong",
    );

    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes(STALE_NAME)) {
            hits.push(`${file.pathname}:${index + 1}: ${line.trim()}`);
          }
        });
    }

    assert.deepEqual(
      hits,
      [],
      `\`${STALE_NAME}\` is the old Ruby-client name: that gem was yanked from RubyGems and renamed to \`specguard-ruby\` (repo github.com/yatfa-ai/specguard-ruby). Use the new name in:\n${hits.join("\n")}`,
    );
  });
});
