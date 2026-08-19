import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { TOOLS } from "../src/tools/index.js";

/**
 * `package.json` ships `files: ["dist", "README.md"]`, so this README is the
 * PUBLISHED documentation of the package — the argument tables under each
 * `### \`tool_name\`` heading are what a consumer reads to learn what they may
 * pass. That makes those tables a third obligation on every tool parameter,
 * alongside the registry's `inputSchema` and the tool's own handling of it.
 *
 * Two of those three columns are already derived: `test/tools/registry.test.ts`
 * iterates `TOOLS` to demand a `description` per property, and
 * `test/index.test.ts` derives the error taxonomy from `errors.ts`. This column
 * was the hand-maintained one, and it is the one that has actually been
 * dropped: `b87f8fa` added `spec_file` and `repeated_description` — 85 lines of
 * source, 213 lines of test — with zero README. The suite was green and the
 * typecheck was clean. A human reviewer caught it in `169bfd5`; no instrument
 * did, because no test in this repo opened the file.
 *
 * So this is DERIVED from `TOOLS` rather than restated from it. Add a parameter
 * and forget the table and this fails, without anyone remembering to extend
 * this file.
 *
 * == Why a table ROW and not a substring
 *
 * The check demands a `| \`name\` |` row rather than merely finding the name
 * somewhere in the section. The prose in these sections discusses the arguments
 * at length and uses overlapping names — `spec_file` is a substring of
 * `spec_files` and of `spec_file_examples`, both of which appear in prose that
 * has nothing to do with documenting the argument. A substring check would
 * therefore call `spec_file` documented on the strength of a sentence about a
 * response key, which is the vacuous-positive shape: the page's own chrome
 * already contains the string you are asserting on.
 *
 * == Why the floors below exist
 *
 * The failure mode this file must not have is its own: a section locator that
 * stops matching (a heading reworded, the tables moved to a separate page)
 * would check zero parameters per tool and pass, permanently and silently. So
 * the README's own content, the tool count, the section lookup and the
 * parameter count are each asserted non-empty, in the manner of
 * `test/index.test.ts:39`. "Nothing to check" must read as a failure here,
 * never as a pass — including when the thing with nothing to check is this
 * file's own reading of the README.
 *
 * NOTE the path: `npm test` runs `node --test .test-build/test/` over compiled
 * output, and `tsconfig.test.json` inherits `rootDir: "."`, so this file lands
 * at `.test-build/test/readme.test.js` and the repo root is TWO levels up.
 * Resolve from `import.meta.url` — `process.cwd()` depends on where the runner
 * was invoked from, and `../README.md` is the depth of the source tree, not of
 * the tree this actually runs in.
 */
const README_URL = new URL("../../README.md", import.meta.url);
const README = readFileSync(README_URL, "utf8");
const README_LINES = README.split("\n");

/** The `##` section the per-tool `###` headings live under. */
const TOOLS_HEADING = "## The tools";

/** A markdown heading of any level — the boundary a tool's section stops at. */
const HEADING = /^#{1,6}\s/;

/**
 * The body of the `### \`toolName\`` section, or `null` if there is no such
 * heading. `null` is deliberately distinct from an empty body: one means the
 * locator found nothing and every check below it would be vacuous, the other
 * means the section is real but says nothing. Both fail, with different
 * messages, because they call for different fixes.
 */
function sectionFor(toolName: string): string[] | null {
  const start = README_LINES.findIndex(
    (line) => line.startsWith("### ") && line.includes(`\`${toolName}\``),
  );
  if (start === -1) return null;

  const body = README_LINES.slice(start + 1);
  const end = body.findIndex((line) => HEADING.test(line));
  return end === -1 ? body : body.slice(0, end);
}

/**
 * The tools that genuinely take NO arguments — enumerated by hand, on purpose.
 *
 * The floor below demands a parameter per tool, because a tool whose schema
 * advertises none would make its parameter loop empty and its whole `describe`
 * block a permanent, meaningless green. `list_repositories` is the first real
 * exception: the `sgu_` credential IS the entire scope of its answer and
 * `GET /api/v1/repositories` takes no parameters, so there is nothing for an
 * argument to select.
 *
 * That is a decision, so it is ENCODED rather than accommodated. Turning the
 * floor into "zero parameters is fine" would have retired the guard for every
 * tool at once, including the next one that forgets to declare its schema. A
 * named set fails for any OTHER argument-less tool until somebody adds it here
 * deliberately — and the two checks under `the argument-less tools` keep the set
 * itself honest in both directions, so it cannot outlive the tools it names or
 * quietly cover a tool that has since grown arguments.
 */
const ARGUMENT_LESS_TOOLS: ReadonlySet<string> = new Set(["list_repositories"]);

/** Matches the argument table's row for one parameter: `| \`name\` | … |`. */
function documentsParameter(section: string[], parameter: string): boolean {
  const escaped = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(`^\\|\\s*\`${escaped}\`\\s*\\|`);
  return section.some((line) => row.test(line));
}

describe("the published README", () => {
  it("was read, and still carries the tools heading the per-tool sections live under", () => {
    // Assert on the raw text, NOT on README_LINES.length: `"".split("\n")` is
    // `[""]`, so a length check over the split is true for every possible input
    // — a floor that cannot fail, which is the exact shape the rest of this file
    // exists to prevent. The heading check gives the floor some reach beyond
    // emptiness: if the tool documentation is ever relocated to another page,
    // that fails HERE, naming the relocation, rather than as a confusing "no
    // section to look in" per tool.
    assert.ok(
      README.trim().length > 0,
      `${README_URL.pathname} is empty; every assertion below would be checking nothing`,
    );
    assert.ok(
      README_LINES.some((line) => line.trimEnd() === TOOLS_HEADING),
      `${README_URL.pathname} has no "${TOOLS_HEADING}" heading. The per-tool "### \`name\`" sections live under it, so if the tool documentation moved to another page this guard now covers nothing — point it at the new page rather than deleting it`,
    );
  });

  it("has tools to check — a probe over an empty registry proves nothing", () => {
    // Guards the derivation itself, in the manner of test/index.test.ts:39. If
    // TOOLS ever comes back empty (a refactor to lazy registration, say), every
    // check below would pass having verified nothing at all.
    assert.ok(TOOLS.length >= 2, `only found ${TOOLS.length} tools in src/tools/index.ts`);
  });

  describe("the argument-less tools", () => {
    it("names only tools that are actually registered", () => {
      // A stale name in the set is a hole with nothing in it: the exemption
      // would sit there covering a tool that no longer exists, ready to be
      // inherited by anything later given the same name.
      const registered = new Set(TOOLS.map((tool) => tool.name));

      for (const name of ARGUMENT_LESS_TOOLS) {
        assert.ok(
          registered.has(name),
          `ARGUMENT_LESS_TOOLS names ${name}, which is not in the registry — remove it rather than leaving an exemption for a tool that does not exist`,
        );
      }
    });

    it("does not cover a tool that has since grown arguments", () => {
      // The other direction, and the one that actually costs coverage: a tool
      // listed here stops having its argument table checked, so the day it gains
      // a parameter the README obligation silently lapses for it. That must fail
      // HERE rather than never.
      for (const tool of TOOLS.filter((candidate) => ARGUMENT_LESS_TOOLS.has(candidate.name))) {
        assert.equal(
          Object.keys(tool.inputSchema.properties ?? {}).length,
          0,
          `${tool.name} is exempted as argument-less but now advertises parameters — drop it from ARGUMENT_LESS_TOOLS so its argument table is checked again`,
        );
      }
    });

    it("leaves at least one tool whose parameters ARE checked", () => {
      // The floor over the exemption itself. If every tool ended up exempted,
      // the parameter loop below would run zero times across the whole registry
      // and this file would be green having opened the README for nothing.
      assert.ok(
        TOOLS.some((tool) => Object.keys(tool.inputSchema.properties ?? {}).length > 0),
        "every tool is argument-less, so no argument table is being verified at all",
      );
    });
  });

  for (const tool of TOOLS) {
    describe(`the \`${tool.name}\` section`, () => {
      const parameters = Object.keys(tool.inputSchema.properties ?? {});
      const section = sectionFor(tool.name);

      it("exists, so the checks below are checking something", () => {
        assert.ok(
          section !== null,
          `README.md has no "### \`${tool.name}\`" heading. Either the tool was added without its README section, or a section was renamed and this guard just stopped covering it — do not delete the check, restore the heading or teach sectionFor about the new shape`,
        );
        assert.ok(
          section.length > 0,
          `the "### \`${tool.name}\`" section is empty, so it documents none of its ${parameters.length} arguments`,
        );
      });

      it("has arguments to check", () => {
        // A tool with no properties would make the loop below empty and this
        // whole describe block a permanent, meaningless green. If an
        // argument-less tool is ever a real thing here, that is a deliberate
        // decision to encode — not something to let slip through as silence.
        // `ARGUMENT_LESS_TOOLS` is where that decision is written down; a tool
        // not in it still has to advertise something.
        if (ARGUMENT_LESS_TOOLS.has(tool.name)) return;

        assert.ok(
          parameters.length > 0,
          `${tool.name} advertises no inputSchema.properties, so nothing here is being verified. If it genuinely takes none, add it to ARGUMENT_LESS_TOOLS at the top of this file — deliberately, and with a section in README.md that says so`,
        );
      });

      for (const parameter of parameters) {
        it(`documents \`${parameter}\` in its argument table`, () => {
          assert.ok(section !== null, `no "### \`${tool.name}\`" section to look in`);
          assert.ok(
            documentsParameter(section, parameter),
            `${tool.name} accepts \`${parameter}\` but README.md's "### \`${tool.name}\`" section has no "| \`${parameter}\` |" row for it. README.md is published with the package (package.json files), so an undocumented argument is one a consumer cannot discover — add the row to the argument table`,
          );
        });
      }
    });
  }
});
