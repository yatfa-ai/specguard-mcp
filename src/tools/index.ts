import addRepository from "./add-repository.js";
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
 * == The fourth: the first tool that WRITES
 *
 *   - `add_repository` wraps `POST /api/v1/repositories` (shipped:
 *     `specguard/config/routes.rb`, `Api::V1::UserRepositoriesController#create`).
 *
 * The endpoint had shipped for a while; what this bridge lacked was a way to
 * CALL it — `support/specguard-api.ts` offered only `getJson`, which hardcoded
 * `method: "GET"` and took no body. The reservation recorded here was that the
 * write transport should land WITH the first write tool, designed against a real
 * request body and a real 4xx surface rather than invented for a caller that did
 * not exist. That is what happened: `postJson`/`postJsonObject` arrived with
 * this entry, sharing `fetchWithTimeout` with the read path rather than standing
 * beside it, and `describeFailure` grew the `400` branch that surfaces
 * SpecGuard's own refusal sentence — the modal answer this endpoint gives.
 *
 * The standing rule is unchanged and still binding, which is what keeps the rest
 * of the user-scoped write surface out: `DELETE /api/v1/repositories/:id` and
 * the API-key endpoints (SPGD-754) are NOT on `origin/main`, so they may not be
 * wrapped here however useful a tool for them would be. What moved was the
 * platform, not the bar.
 */
export const TOOLS: readonly ToolDefinition[] = [
  lintIntentAnnotations,
  getRepositoryOverview,
  listRepositories,
  addRepository,
];

export type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
