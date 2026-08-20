import lintIntentAnnotations from "./lint-intent-annotations.js";
import listRepositories from "./list-repositories.js";
import getRepositoryOverview from "./repository-overview.js";
import type { ToolDefinition } from "./types.js";

/**
 * THE REGISTRY — the one file that changes when the toolset grows.
 *
 * SPGD-310 ships a bootstrap, not a tool contract: the initial set wraps
 * capabilities that are verified-shipped today, and the rest fills in as more
 * of SpecGuard lands. This array is the seam that makes that true. `server.ts`
 * iterates it and has no knowledge of any individual tool, so adding one is a
 * new file plus one line here — no new plumbing, no `switch` to extend, no
 * change to how the server starts, authenticates or reports errors.
 *
 * == What is in the bootstrap, and why only these two
 *
 *   - `lint_intent_annotations` wraps `specguard-lint` (shipped:
 *     `specguard-rspec/bin/specguard-lint`, SPGD-12 §1).
 *   - `get_repository_overview` wraps `GET /api/v1/repository` (shipped:
 *     `specguard/config/routes.rb`).
 *
 * Both were confirmed present before being wrapped, and the two chosen cover
 * the two halves of the surface — one local subprocess, one authenticated HTTP
 * call — so the shape is proven on both kinds of capability rather than on one.
 *
 * == The third: the first tool that reads the OTHER credential
 *
 *   - `list_repositories` wraps `GET /api/v1/repositories` (shipped:
 *     `specguard/config/routes.rb`, `Api::V1::UserRepositoriesController`).
 *
 * It is the only tool here that answers to an `sgu_` USER key rather than an
 * `sgk_` repository key, and SpecGuard refuses each credential in the other's
 * place before it reads a table. So this entry is also what proves the second
 * variable, the second `require*` helper and the credential-aware diagnostics
 * work end to end — one tool, over a real endpoint, rather than a seam nothing
 * exercises.
 *
 * == What is deliberately absent
 *
 * `/check-intent` and duplicate clustering are NOT here and must not be added
 * until their backing engine and data exist (SPGD-114 / SPGD-115). A tool
 * advertised in `tools/list` is a promise an agent will act on: wrapping an
 * endpoint that does not exist would produce a server that discovers cleanly
 * and fails on use, which is worse than not offering the tool, because the
 * agent has already committed to a plan by the time it finds out.
 *
 * The user-scoped WRITE endpoints are absent for a different reason, and it is
 * worth stating so nobody re-derives the wrong one: `POST /api/v1/repositories`
 * exists on the platform today. What this bridge does not have is a way to call
 * it — `support/specguard-api.ts` offers `getJson`, which hardcodes
 * `method: "GET"` and takes no body. That transport lands with the first write
 * tool, designed against a real request body and a real 4xx surface, rather
 * than being invented here for a tool that does not yet exist.
 */
export const TOOLS: readonly ToolDefinition[] = [
  lintIntentAnnotations,
  getRepositoryOverview,
  listRepositories,
];

export type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
