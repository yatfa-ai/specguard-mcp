import addRepository from "./add-repository.js";
import createRepositoryApiKey from "./create-repository-api-key.js";
import lintIntentAnnotations from "./lint-intent-annotations.js";
import listRepositories from "./list-repositories.js";
import nearDuplicateClusters from "./near-duplicate-clusters.js";
import getRepositoryOverview from "./repository-overview.js";
import registrableRepositories from "./registrable-repositories.js";
import removeRepository from "./remove-repository.js";
import revokeRepositoryApiKey from "./revoke-repository-api-key.js";
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
 * `/check-intent` is NOT here and must not be added until its backing endpoint
 * exists — `specguard/config/routes.rb:113` carries it as a comment only, which
 * is the evidence this forbid rests on. A tool advertised in `tools/list` is a
 * promise an agent will act on: wrapping an endpoint that does not exist would
 * produce a server that discovers cleanly and fails on use, which is worse than
 * not offering the tool, because the agent has already committed to a plan by
 * the time it finds out.
 *
 * Duplicate clustering was once under this same forbid, on the same standing
 * rule — no tool may wrap what has not shipped. That half retired when the
 * platform moved: SPGD-703 (`specguard` `c43dc19`, 2026-08-28) shipped
 * `GET /api/v1/repository?near_duplicates=`, serving
 * `RepositoryOverview#serialized_near_duplicates` behind an opt-in ask, and
 * `near_duplicate_clusters` below wraps it. What moved was the platform, not
 * the bar.
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
 * The standing rule is unchanged and still binding. What once kept `DELETE
 * /api/v1/repositories/:id` and the API-key endpoints out under it — "not on
 * `origin/main`, so they may not be wrapped" — stopped being true when SPGD-754
 * shipped them, and the sixth-through-eighth section below records their
 * wrapping. What moved was the platform, not the bar.
 *
 * == The fifth: the read half of the registration gate
 *
 *   - `registrable_repositories` wraps `GET /api/v1/repositories/registrable`
 *     (shipped: `specguard/config/routes.rb:117`,
 *     `Api::V1::UserRepositoriesController#registrable`).
 *
 * `list_repositories` says what IS registered; this says what COULD be — the
 * set the gate would consult, read out in advance, so an agent can pick a
 * `full_name` for `add_repository` from a real answer. Landing it also
 * generalised the 400 branch in `describeFailure` into a status-parameterised
 * extractor, because this endpoint's modal first answer is a 403 (`not_granted`)
 * carrying the same `{error, message}` contract — the identical defect, given
 * the identical remedy.
 *
 * The user-scoped surface as it now stands is therefore three tools: read the
 * list, read the gate's answer, write a registration. The standing rule is
 * unchanged and still binding, which is what keeps the rest out:
 * `DELETE /api/v1/repositories/:id` and the API-key endpoints (SPGD-754) are
 * NOT on `origin/main`, so they may not be wrapped here however useful a tool
 * for them would be. What moved was the platform, not the bar.
 *
 * == The sixth through eighth: removal and the key lifecycle
 *
 *   - `remove_repository` wraps `DELETE /api/v1/repositories/:id`, and
 *     `create_repository_api_key` / `revoke_repository_api_key` wrap the two
 *     `api_keys` endpoints (all shipped: SPGD-754, `specguard@origin/main`).
 *
 * The closing fence the two paragraphs above share — "the DELETE and API-key
 * endpoints are NOT on `origin/main`, so they may not be wrapped" — stopped
 * being true when SPGD-754 landed, and these three entries are what became
 * wrappable the moment it did. They also forced the transport's third verb:
 * both DELETE endpoints answer `204` with NO body, the one response in the
 * `sgu_` surface that is deliberately not JSON, which is why `deleteJson`
 * returns the raw body text instead of routing an empty 204 through
 * `requestJson`'s JSON parse.
 *
 * The standing rule itself is unchanged and still binding — which still keeps
 * out `/check-intent`, member management and rename: none of their backing
 * endpoints has shipped, and a tool advertised in `tools/list` remains a
 * promise an agent will act on.
 */
export const TOOLS: readonly ToolDefinition[] = [
  lintIntentAnnotations,
  getRepositoryOverview,
  listRepositories,
  addRepository,
  registrableRepositories,
  removeRepository,
  createRepositoryApiKey,
  revokeRepositoryApiKey,
  nearDuplicateClusters,
];

export type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
