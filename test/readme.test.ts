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
 * block a permanent, meaningless green. `list_repositories` was the first real
 * exception — the `sgu_` credential was the entire scope of its answer and
 * `GET /api/v1/repositories` took no parameters — until SPGD-940 (`ef6236d`)
 * grew the endpoint three narrowing asks and SPGD-1037 grew the tool the three
 * arguments that forward them. It left this set when it grew rather than being
 * accommodated, which is the direction this set exists to force: an exemption
 * must not outlive the argument-less shape it named.
 *
 * That is a decision, so it is ENCODED rather than accommodated. Turning the
 * floor into "zero parameters is fine" would have retired the guard for every
 * tool at once, including the next one that forgets to declare its schema. A
 * named set fails for any OTHER argument-less tool until somebody adds it here
 * deliberately — and the two checks under `the argument-less tools` keep the set
 * itself honest in both directions, so it cannot outlive the tools it names or
 * quietly cover a tool that has since grown arguments.
 *
 * `near_duplicate_clusters` used to be here: its ask is FLAG shaped
 * (`?near_duplicates=`), the server reads only that the key is present, and
 * there is no value for an argument to carry. SPGD-953 added `repository` —
 * which names WHICH repository is censused, not anything about the census — so
 * the tool now advertises a parameter and belongs in the checked set again,
 * exactly as the "grown arguments" guard below demands.
 */
const ARGUMENT_LESS_TOOLS: ReadonlySet<string> = new Set([
  "registrable_repositories",
  // SPGD-1200: `get_server_version` wraps the root-level `GET /version`, which
  // takes no parameters and answers no ask an argument could narrow — the
  // deployment's build is the whole of the answer, and the credential is
  // already absent. Added here deliberately, with the guards above keeping
  // the set honest in both directions, exactly as `registrable_repositories`
  // was.
  "get_server_version",
  // SPGD-1331: `get_intent_schema` wraps the root-level schema mirror, which
  // takes no parameters because a DOCUMENT has no ask to narrow — the whole
  // contract is the whole answer, and serving a subset of it would put this
  // bridge in the business of deciding which half of a contract an agent may
  // read. Added here deliberately, under the same both-directions guards: the
  // day this tool grows a parameter, the "since grown arguments" check above
  // fails and its argument table is checked again.
  "get_intent_schema",
]);

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

      it("has arguments to check", (t) => {
        // A tool with no properties would make the loop below empty and this
        // whole describe block a permanent, meaningless green. If an
        // argument-less tool is ever a real thing here, that is a deliberate
        // decision to encode — not something to let slip through as silence.
        // `ARGUMENT_LESS_TOOLS` is where that decision is written down; a tool
        // not in it still has to advertise something.
        //
        // Reported as a SKIP, not as a bare return: this file's own rule is that
        // "nothing to check" must never read as a pass, and an exempted tool
        // returning early would print a green "has arguments to check" having
        // asserted nothing — the exact shape the rule forbids, one level up. The
        // three guards over the set itself are what make the exemption safe, so
        // it costs nothing to say out loud in the runner output.
        if (ARGUMENT_LESS_TOOLS.has(tool.name)) {
          return t.skip("exempted by ARGUMENT_LESS_TOOLS — see the guards at the top of this file");
        }

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

/**
 * == The response keys a description names
 *
 * The argument guard above covers one of the README's two obligations. The
 * other is the RESPONSE side: every tool's top-level `description` — the text
 * an agent actually reasons over — names response keys in backticks, and a
 * consumer cannot act on a key the published README never names. That column
 * was guarded by nothing, and it is the one that has actually been dropped:
 * SPGD-690 (`42680f5`) grew `get_repository_overview`'s description with three
 * keys — `suite_size_measured`, `shard_count`, `timed_shard_count` — and zero
 * README, and the suite stayed green for a month because no test in this repo
 * read the README for response keys.
 *
 * So this too is derived from `TOOLS`, and the derivation is measured, not
 * assumed. Across the registry it extracts 157 unique backticked identifiers
 * (`` `[a-z_][a-z0-9_]{3,}` ``, tool names dropped) from the top-level
 * descriptions; 17 tools carry at least one; and before this guard landed
 * exactly four of the 157 were absent from their tool's section — the three
 * SPGD-690 keys, plus `api_key` on `list_repository_api_keys` — and all four
 * were documented in the same commit as this guard, because a guard that goes
 * red on adoption must not be merged beside docs that leave it red.
 *
 * == Why presence is matched at word boundaries, never as a substring
 *
 * The trap the argument guard solves with table ROWS applies here twice over,
 * and a plain substring check walks into both. `api_key` on
 * `list_repository_api_keys` reads as "documented" on the strength of the tool
 * names `create_repository_api_key` and `revoke_repository_api_key` appearing
 * in the section's rotation prose — the page's own chrome already contains the
 * string being asserted on, which is this file's own definition of a
 * vacuous positive. And once `timed_shard_count` is documented, a substring
 * check would keep `shard_count` green even if every plain mention of it were
 * deleted. `\b` boundaries reject both — an underscore is a word character, so
 * `shard_count` is not found inside `timed_shard_count`, and `api_key` is not
 * found inside a tool name — while a dotted path such as `run_anchor.resolved`
 * still documents `run_anchor`, and a code span wrapped across a README line
 * break still reads, because the section is joined before matching.
 *
 * == Why the description is read from the registry, never from the file
 *
 * `rejections_window` appears in `repository-overview.ts` — in a source
 * comment, not in the description literal — and is correctly not an
 * obligation, so a grep of the file would manufacture a finding. Importing
 * `TOOLS` also makes the `"..." + "..."` concatenation seams moot: the strings
 * are joined before this test ever sees them, so an identifier cannot be
 * missed for straddling a seam.
 *
 * == The floors
 *
 * Two tools' top-level descriptions contain no identifier-shaped backticked
 * token at all, so their census would be empty and the checks below them
 * vacuous; they are exempted by name in `IDENTIFIER_LESS_DESCRIPTIONS`, with
 * the same three guards the argument-less set has. The registry-wide census
 * floor catches the slower decay a per-tool floor cannot: an extraction
 * regression that still yields a token or two per tool but no longer the
 * measured 157. And the derivation itself is tested against synthetic
 * fixtures, so gutting the detector to a constant cannot pass silently —
 * the executable form of "the guard must flag an identifier a section omits".
 */
const RESPONSE_IDENTIFIER = /`([a-z_][a-z0-9_]{3,})`/g;

const REGISTERED_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));

/**
 * The unique identifiers one tool's top-level description names in backticks,
 * minus identifiers that are themselves tool names: a description may reference
 * a sibling tool (`list_repositories`) without obligating its own section to
 * document it as a response key.
 */
function mentionedIdentifiers(description: string): string[] {
  const found: string[] = [];
  for (const match of description.matchAll(RESPONSE_IDENTIFIER)) {
    const identifier = match[1];
    if (identifier !== undefined && !REGISTERED_TOOL_NAMES.has(identifier)) {
      found.push(identifier);
    }
  }
  return [...new Set(found)];
}

/**
 * Whether a section NAMES an identifier — at word boundaries, never as a
 * substring; see the docblock above for the two vacuous positives a substring
 * check would serve.
 */
function documentsIdentifier(section: string[], identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(section.join("\n"));
}

/**
 * The tools whose top-level description names no identifier-shaped backticked
 * token — enumerated by hand, on purpose, for the same reason
 * `ARGUMENT_LESS_TOOLS` is. An empty census makes every check over it a
 * permanent, meaningless green, so the exemption must be a decision encoded
 * here, guarded in both directions below, never a floor relaxed for everyone.
 */
const IDENTIFIER_LESS_DESCRIPTIONS: ReadonlySet<string> = new Set([
  // Its description's only backticked tokens are `@intent:` and
  // `specguard-lint` — one starts with `@`, one carries a hyphen — so the
  // extraction genuinely yields nothing, today and by shape.
  "lint_intent_annotations",
  // `get_server_version` sat here while its description's backticked tokens
  // were all path-, JSON- and uppercase-shaped (`GET /version`, `serverInfo`,
  // `{"version": "0.1.46"}`, `{version}`, `version: null`,
  // `SPECGUARD_ENDPOINT`, `Authorization`) — none identifier-shaped, so its
  // one response key (`version`) was never a bare backticked token in the
  // description. SPGD-1366 corrected the stale `{"version"}`-shape sentence
  // and named the body's contract-identity keys in backticks, so the
  // exemption lapsed by this file's own guard above: the description now
  // names `schema_sha256` and `schema_origin`, and the per-identifier checks
  // below cover them. Retired rather than accommodated — the same direction
  // `ARGUMENT_LESS_TOOLS` forces.
]);

describe("the response keys a description names", () => {
  /** Unique identifiers across every non-exempt description: 157 when measured. */
  const censusTotal = TOOLS.filter((tool) => !IDENTIFIER_LESS_DESCRIPTIONS.has(tool.name)).reduce(
    (total, tool) => total + mentionedIdentifiers(tool.description).length,
    0,
  );

  it("has a census worth checking — an extractor that stopped matching would green everything below", () => {
    // Measured at 157 when this guard landed (17 identifier-bearing tools; the
    // same figure the ticket's instrument reported). Deliberately far below the
    // measurement: the floor exists to catch a broken extraction (a retuned
    // regex, a renamed description field), not to freeze description content.
    assert.ok(
      censusTotal >= 100,
      `the response-key census across all tool descriptions is ${censusTotal}, below the floor of 100 — the extraction has probably stopped matching, and every per-identifier check below would be green having verified nothing`,
    );
  });

  describe("the derivation itself", () => {
    it("flags a description identifier its section omits, and clears one it names", () => {
      // The guard compares two independently-sourced texts — the served
      // description and the README — so it is derived, not a restatement.
      // Asserting that on synthetic fixtures is what stops a later edit from
      // gutting the detector into a constant and staying green.
      const description =
        "Returns `alpha_result` on every call, and `beta_result` when narrowed.";
      assert.deepEqual(mentionedIdentifiers(description), ["alpha_result", "beta_result"]);
      const section = ["Every call carries `alpha_result`; nothing here names the other one."];
      assert.deepEqual(
        mentionedIdentifiers(description).filter((id) => !documentsIdentifier(section, id)),
        ["beta_result"],
      );
    });

    it("does not let a longer identifier or a tool name document a shorter one", () => {
      // Both of these read as documented under a substring check — the
      // chrome trap this column exists to refuse.
      const section = [
        "Ride every row: `timed_shard_count`, minted by `create_repository_api_key`.",
      ];
      assert.ok(!documentsIdentifier(section, "shard_count"));
      assert.ok(!documentsIdentifier(section, "api_key"));
      assert.ok(documentsIdentifier(section, "timed_shard_count"));
      assert.ok(documentsIdentifier(section, "create_repository_api_key"));
    });
  });

  describe("the identifier-less descriptions", () => {
    it("names only tools that are actually registered", () => {
      const registered = new Set(TOOLS.map((tool) => tool.name));

      for (const name of IDENTIFIER_LESS_DESCRIPTIONS) {
        assert.ok(
          registered.has(name),
          `IDENTIFIER_LESS_DESCRIPTIONS names ${name}, which is not in the registry — remove it rather than leaving an exemption for a tool that does not exist`,
        );
      }
    });

    it("does not cover a description that has since grown identifiers", () => {
      // The direction that costs coverage: an exempted description stops having
      // its identifiers checked, so the day one gains a backticked identifier
      // the response-key obligation silently lapses for it. That must fail
      // HERE rather than never.
      for (const tool of TOOLS.filter((candidate) =>
        IDENTIFIER_LESS_DESCRIPTIONS.has(candidate.name),
      )) {
        assert.equal(
          mentionedIdentifiers(tool.description).length,
          0,
          `${tool.name} is exempted as identifier-less but its description now names backticked identifiers — drop it from IDENTIFIER_LESS_DESCRIPTIONS so its response keys are checked again`,
        );
      }
    });

    it("leaves at least one tool whose identifiers ARE checked", () => {
      assert.ok(
        censusTotal > 0,
        "every description is identifier-less, so no response key is being verified at all",
      );
    });
  });

  for (const tool of TOOLS) {
    const census = mentionedIdentifiers(tool.description);

    describe(`the \`${tool.name}\` description's identifiers`, () => {
      it("yields identifiers to check", (t) => {
        // Skip, not silent return: "nothing to check" must never read as a
        // pass, exactly as the argument guard's own skip says.
        if (IDENTIFIER_LESS_DESCRIPTIONS.has(tool.name)) {
          return t.skip("exempted by IDENTIFIER_LESS_DESCRIPTIONS — see the guards above");
        }

        assert.ok(
          census.length > 0,
          `${tool.name}'s top-level description names no backticked identifier, so nothing here is verified. If that is genuine, add it to IDENTIFIER_LESS_DESCRIPTIONS — deliberately, with the reason`,
        );
      });

      for (const identifier of census) {
        it(`documents \`${identifier}\` in its README section`, () => {
          const section = sectionFor(tool.name);
          assert.ok(section !== null, `no "### \`${tool.name}\`" section to look in`);
          assert.ok(
            section.length > 0,
            `the "### \`${tool.name}\`" section is empty, so it names none of the identifiers its description serves`,
          );
          assert.ok(
            documentsIdentifier(section, identifier),
            `${tool.name}'s description names \`${identifier}\` but README.md's "### \`${tool.name}\`" section never does (word-boundary match). README.md is published with the package (package.json files), so a response key the docs never name is one a consumer cannot discover — name it in the section`,
          );
        });
      }
    });
  }
});
