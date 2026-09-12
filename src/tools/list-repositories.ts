import { getJsonObject, requireUserOrAgentApiConfig } from "../support/specguard-api.js";
import { optionalString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repositories` as a tool — shipped today in the platform
 * (`specguard/config/routes.rb`, `Api::V1::UserRepositoriesController#index`).
 *
 * == Why this is the first user-scoped tool, and for now the only one
 *
 * Every other tool here answers about ONE repository the caller has already
 * named — and a bridge that can only answer about a repository you can already
 * name cannot tell an agent which repositories there ARE. `get_repository_overview`
 * without `repository` does not take a repository: its `sgk_` key IS the repository,
 * so the question "what may I ask about" has no answer anywhere in this server. This
 * is that answer, and it is the whole of what this tool does.
 *
 * It is also the tool that proves the second credential slot works end to end,
 * which is why it shipped alone. It no longer IS alone: `add_repository`
 * (SPGD-764) reads the same `sgu_` key and wraps `POST /api/v1/repositories`,
 * which arrived once this bridge had a write transport to call it with —
 * `postJson`/`postJsonObject` in `support/specguard-api.ts`, landed with that
 * tool and designed against a real request body and a real 4xx surface, exactly
 * as the reservation recorded here asked. The registry's standing rule
 * (`tools/index.ts`) is unchanged and still binding: a tool in `tools/list` is a
 * promise an agent acts on, so the REST of the user-scoped surface — removing a
 * repository, minting or revoking keys — stays out until those endpoints ship.
 *
 * What this tool still uniquely answers is the question above: which
 * repositories there ARE. `add_repository` extends that surface rather than
 * replacing it, and the two share a handle — the `full_name` reported here is
 * the `full_name` that one takes.
 *
 * == It reads the OTHER key, and that is the point
 *
 * `Api::BaseController` decides which credential table to consult from the
 * token's PREFIX, before any table is read, and answers 401 on a mismatch
 * without a lookup — so this endpoint refuses the `sgk_` key
 * `get_repository_overview` uses, and that one refuses this key. Hence a
 * `require*` helper rather than a raw key: the `Credential` carried on the
 * resolved config is what makes a 401 or an unset variable name the one the
 * OPERATOR of this tool has to go and fix. See `config.ts`.
 *
 * Since SPGD-953 it is `requireUserOrAgentApiConfig`, because SPGD-952 made the
 * endpoint answer to BOTH key kinds — the person's `accessible_by` set for an
 * `sgu_` key, the agent key's own granted set for an `sga_` one — and an agent
 * holding only the agent credential must still be able to ask "what may I ask
 * about". When both variables are set the agent key wins, so the listing names
 * the same set every other agent-keyed tool answers inside; the precedence and
 * its reasoning live on the helper.
 *
 * == The credential is the SCOPE, and the arguments narrow WITHIN it
 *
 * This file first shipped argument-less on a premise that has since rotted: it
 * said "the endpoint takes no parameters", because the credential behind the
 * key was the entire scope of the answer. That stopped being true on
 * 2026-09-05, when specguard `ef6236d` (SPGD-940, #941) grew
 * `GET /api/v1/repositories` three narrowing asks through the shared
 * `RepositoryNarrowing` concern — `?q=` (case-insensitive substring on
 * `github_full_name`, with the LIKE wildcards escaped server-side, so a
 * literal `org/my_repo` does not widen into a pattern match), `?role=owned`
 * and `?role=shared` (the exact partition of the accessible set into owned and
 * shared halves), and `?sort=stale` (never-ingested repositories first, then
 * least-recently-ingested, `github_full_name` breaking ties so the order is
 * deterministic). The concern's own comment says the endpoint reads them "for
 * a machine" — and this bridge IS that machine, so they are forwarded here
 * rather than re-invented.
 *
 * What has NOT changed is which side of the boundary the asks sit on. WHICH
 * boundary answered follows the credential — `Repository.accessible_by` (owned
 * UNION shared-through-a-membership) for an `sgu_` key, `AgentApiKey#repositories`
 * (the mint-time granted set) for an `sga_` one — and either way it is the
 * platform's read-side rule, not a filter this bridge could widen or narrow:
 * the controller chains every ask onto the relation that boundary already
 * admitted (`narrow_repositories(authorized_repositories, …)`), so a
 * repository the credential does not admit never ENTERS the relation and no
 * argument here widens the answer — it can only narrow, or re-order, what the
 * credential already admits. Out-of-vocabulary values are the server's to
 * clamp, not ours: an unknown `role` or `sort` settles to the no-ask, never a
 * 400, which is also why a value that reaches the wire is passed through
 * verbatim rather than validated against a second vocabulary here. Under the
 * agent key the `?role=` ask clamps to the no-ask outright — ownership is a
 * person fact and the key speaks for nobody, so there is no owned/shared line
 * to draw (`UserRepositoriesController#requested_role` is where the server
 * writes that rule, beside `#credential_role`'s `role: "agent"`).
 *
 * Blank is no ask, and so is undefined: `optionalString` returns `undefined`
 * for a blank value and `getJson` omits an `undefined` query entry, so
 * declining an ask and omitting the argument are the same wire request — the
 * established spelling in this codebase (`repository-overview.ts` states it
 * as build-don't-stringify), and the reason the no-ask request below is
 * byte-identical to the one this tool made before it had arguments at all.
 *
 * == The response is passed through, not re-modelled
 *
 * Same rule as every other tool here (`types.ts`: "A thin client that reshapes
 * its upstream is not thin"), and it has real content on this body. The
 * controller serves each entry as `id`, `full_name`, `name`, `registered_at`,
 * `role`, `delivery_health` and `latest_run`
 * (`Api::V1::UserRepositoriesController#serialize`), and it says why about the
 * identity fields: `id`, `full_name`, `name` and `registered_at` are
 * DELIBERATELY the same fields, under the same names, that
 * `GET /api/v1/repository` serves in its own `repository` block, so a client
 * that has read one knows how to read the other. Renaming or flattening
 * anything here would spend that parity on the last hop. The rest of each
 * entry — and the block beside `repositories:` at the top level — is payload an
 * agent must know ARRIVES: a description that omits it sends the agent to pay
 * per-repository calls for data this one call already handed it (SPGD-1067).
 *
 * `delivery_health` rides EVERY entry (`#delivery_verdicts`): `{refusing,
 * last_rejection_at}` — the staleness verdict `get_repository_overview` serves
 * in its fuller per-repository block, spelled here as the one-call fleet
 * triage. "Which of my repositories has a refusing ingest pipeline?" is
 * answerable from THIS call alone, never one overview call per repository. A
 * quiet verdict is a finding, not a gap, on the same rule the overview's
 * description states: `refusing: false` is "nothing was refused", not
 * "delivery is untracked".
 *
 * `latest_run` is the entry's newest run at the serializer's LIST depth
 * (`LatestRunSerializer::LIST_DEPTH`): when CI last reported, on what branch
 * and commit, how big the suite is, how much of it SpecGuard can read, and the
 * run-level cost scalars — the drill-ins stay on the overview's full depth.
 * `null` means CI has NEVER reported for that repository, and on this list the
 * key is PRESENT-and-null (`#index` always passes the block;
 * `LatestRunSerializer#body` returns nil for a nil run), the serializer's
 * "nil, not a zeroed block" rule — a repository CI has never run must not read
 * byte-identically to one that ran and found an empty suite. The ABSENT-key arm
 * of that same marker belongs to `#update`'s rename receipt, not to this list.
 *
 * `credential` is the block that is NOT repository-scoped: under an `sga_` key
 * the TOP level carries `credential: {capabilities}` — the calling key's own
 * grant (SPGD-977), with every capability in `RepositoryPolicy::CAPABILITIES`
 * ASKED of `AgentApiKeyPolicy` server-side, so the booleans cannot disagree
 * with a 403 the same key would get (an empty permission set thereby reads
 * affirmatively — `view` true, every further verb false, the machine
 * counterpart of the account page's "read only" — rather than a copy of the
 * stored permissions array, which under-states and over-states the grant at
 * once). Its only other carrier is the minting person's browser account page,
 * so before it a machine credential's only discovery path for its own
 * permissions was 403 trial-and-error. Under an `sgu_` key the block is ABSENT
 * rather than nulled — a person key has no mint-time permission set, and a null
 * would assert one exists and is empty.
 *
 * `role` is the field this surface adds, and its value depends on WHICH
 * credential answered — three values, one per credential kind, and all three
 * are named rather than left to be discovered from the data, because an agent
 * that will later register keys or change settings needs to know which of these
 * entries it may expect to administer. Under the `sgu_` PERSON key it is
 * `"owner"` or `"member"`: the list MIXES repositories the person owns with
 * repositories somebody shared with them, and no other field separates the two.
 * Under the `sga_` AGENT key every entry is `"agent"` — the key is NOBODY, so
 * the owner/member question does not apply, and a client branching on
 * owner/member reads false for both, which is the correct reading rather than a
 * gap (`Api::V1::UserRepositoriesController#credential_role` is where the
 * server writes that rule down, beside the `?role=` clamp that exists for the
 * same reason). One value per kind also means the field identifies WHICH
 * credential served the list — worth knowing when both variables are set and
 * the agent key wins.
 *
 * The order is `full_name` ascending, which the controller picks as the only
 * column a client can page or diff against without SpecGuard promising an id
 * ordering it has not designed — and `?sort=stale` re-sequences exactly that
 * loaded set rather than issuing a different query, so the entries never
 * change, only their order does. It is stated here for the same reason the
 * other tool states its orders: a list whose order is a coincidence and a list
 * whose order is a contract look identical in a response body.
 */
const listRepositories: ToolDefinition = {
  name: "list_repositories",
  title: "List repositories",
  description:
    "Lists the SpecGuard repositories this server's key may open — the answer to \"what can I " +
    "ask about\", which no other tool here can give, because every other tool is already scoped " +
    "to one repository by its key. " +
    "Each entry carries `id`, `full_name` (`org/repo`, and the handle every other surface names " +
    "a repository by), `name`, `registered_at`, `role`, `delivery_health` and `latest_run`. " +
    "`delivery_health` is the entry's delivery verdict — `refusing` beside `last_rejection_at` — " +
    "served on every entry, so this one call triages ingest-pipeline health across the whole " +
    "reachable set (the coarse sibling of get_repository_overview's fuller per-repository block) " +
    "instead of paying one overview call per repository. A quiet verdict is a finding, not a " +
    "gap: `refusing: false` means nothing was refused, never that delivery is untracked. " +
    "`latest_run` is the entry's newest run — when CI last reported, on what branch and commit, " +
    "how big the suite is, how much of it SpecGuard can read, and the run-level cost scalars; " +
    "`null` means CI has never reported for that repository, never a run that found an empty " +
    "suite. " +
    "`role` has one value per credential kind. Under a PERSON key (`sgu_…`) it is `owner` or " +
    "`member`: the list mixes repositories this person owns with repositories somebody shared " +
    "with them, and nothing else distinguishes the two. Under an AGENT key (`sga_…`) every " +
    "entry is `agent` — the value that says the ownership question does not apply because the " +
    "key speaks for nobody; branching on owner/member correctly reads false for both. Read it " +
    "before assuming a repository is yours to administer. " +
    "Under an AGENT key the top level also carries `credential.capabilities` — the calling " +
    "key's own grant, read through the server's policy, so an agent key sees what it was " +
    "granted here instead of discovering its permissions by hitting refusals; under a PERSON " +
    "key the block is ABSENT, not `null`, because a person key has no mint-time permission " +
    "set. " +
    "Three optional asks narrow WITHIN that set — none of them can widen it — all optional, " +
    "composable on one call: `q` (case-insensitive substring on `full_name`), " +
    "`role: \"owned\"` or `\"shared\"` (one half of the owned/shared mix — note the ask is " +
    "spelled `owned`, not the response field's `owner`; under the AGENT key this ask settles " +
    "to the no-ask, because ownership is a person fact and the key speaks for nobody), and " +
    "`sort: \"stale\"` (repositories " +
    "CI has never ingested a run for first, then least-recently-ingested, `full_name` " +
    "breaking ties). Omit them all and the request is the plain full list. " +
    "Ordered by `full_name` ascending unless `sort` asks otherwise, and stable across calls " +
    "either way. " +
    "The set is exactly what the key behind it may see — a repository outside the credential's " +
    "own boundary is absent rather than filtered, so an empty list means no access, never an " +
    "error. " +
    "It authenticates with EITHER of this server's two list-scoped credentials, whichever is " +
    "set: SPECGUARD_AGENT_API_KEY (an sga_… key — the answer is the repository set granted onto " +
    "that key at mint time, the same set every other agent-keyed tool here answers inside) and, " +
    "when that is not set, SPECGUARD_USER_API_KEY (an sgu_… key — the answer is what that person " +
    "may open). With both set the agent key wins, so discovery stays inside the set the other " +
    "tools can actually reach. " +
    "Either way it is a DIFFERENT credential from the sgk_… repository key " +
    "get_repository_overview reads; SpecGuard refuses each in the other's place.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "Keep only the repositories whose `github_full_name` (`org/repo`) CONTAINS this " +
          "substring, case-insensitively — the same ask the deployment's web grid reads. " +
          "A plain substring, not a pattern: the server matches with `ILIKE '%…%'` and escapes " +
          "the LIKE wildcards (`%`, `_`, `\\`) first, so `org/my_repo` matches itself rather " +
          "than widening into `my-repo` and `myxrepo`. " +
          "It narrows the SAME set the plain call serves — a repository the credential does not " +
          "admit never enters the response, so no `q` can make one appear — and an ask that " +
          "matches nothing is an empty list with a 200, the same answer as having no access, " +
          "not an error. " +
          "Blank (or null) is no ask: the request is then byte-identical to omitting the " +
          "argument.",
      },
      role: {
        type: "string",
        enum: ["owned", "shared"],
        description:
          "Keep only ONE half of the list's mix: `owned` keeps the repositories this person " +
          "owns, `shared` keeps the ones somebody shared with them. The two partition the " +
          "accessible set exactly — a repository owned AND shared cannot exist by construction, " +
          "so nothing is lost by asking for one half — and both chain onto the credential " +
          "boundary, so neither half can be wider than the plain call's answer. " +
          "THE ASK VALUES ARE SPELLED DIFFERENTLY FROM THE RESPONSE FIELD: an entry's `role` is " +
          "`\"owner\"`/`\"member\"` under the PERSON key and `\"agent\"` under the AGENT one (the " +
          "key speaks for nobody), but the ask is `owned`/`shared` — send `role: " +
          "\"owner\"` and you are not asking for anything. A client that honours this schema " +
          "cannot send it (the enum refuses it before the call); a client that bypasses the " +
          "schema gets the server's clamp, where any value outside `owned`/`shared` settles to " +
          "the no-ask and the full list is served — never an error — and under the AGENT key " +
          "the ask settles to the no-ask for EVERY value, because ownership is a person fact " +
          "and the key speaks for nobody. " +
          "Blank (or null) is no ask: byte-identical to omitting the argument.",
      },
      sort: {
        type: "string",
        enum: ["stale"],
        description:
          "Re-order the list stalest-first. The default order is `full_name` ascending, which " +
          "is stable across calls but says nothing about what needs attention; `stale` puts " +
          "the repositories CI has NEVER ingested a run for FIRST (never-ingested is the " +
          "stalest state on this list, not a zero), then least-recently-ingested, newest last, " +
          "with `github_full_name` breaking ties so two calls with the same data agree element " +
          "for element. " +
          "It re-sequences the loaded set rather than issuing a different query: the same " +
          "entries, a different order. `stale` is the only ordering the endpoint names — there " +
          "is deliberately no word for the default, because omitting the argument already " +
          "means it. " +
          "Any other value a schema-bypassing client sends settles to the server's no-ask clamp " +
          "(default order, no error); blank (or null) is no ask, byte-identical to omitting the " +
          "argument.",
      },
    },
    // Still CLOSED rather than open: `additionalProperties: false` is advertised
    // in `tools/list`, so a client that honours the schema REJECTS an invented
    // argument before the call is made. Nothing on this side refuses it —
    // `server.ts` forwards `arguments` unvalidated — so an open schema would
    // have the argument silently dropped and the call answered as if it had
    // been honoured. The enum vocabularies above are the server's own accepted
    // values (`RepositoryNarrowing`'s ROLES and SORTS), not a second list this
    // bridge keeps in step by hand.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    const q = optionalString(args["q"], "q");
    const role = optionalString(args["role"], "role");
    const sort = optionalString(args["sort"], "sort");
    // EITHER credential the endpoint serves — agent key preferred, user key as
    // the fallback, both named in the refusal when neither is set. The
    // precedence and its scope argument live on the helper in `config.ts`.
    const api = requireUserOrAgentApiConfig(context.config);

    // Built, not stringified — the established rule for a query object
    // (`repository-overview.ts`): `getJson` omits an `undefined` entry and sets
    // everything else verbatim, so an ask declined (blank), omitted, or never
    // defined all compose to the ONE request the caller meant, and with no asks
    // at all the object is `{}` — the byte-identical request this tool made
    // before it had arguments.
    const listing = await getJsonObject(
      api,
      "/api/v1/repositories",
      { q, role, sort },
      context.fetch,
    );

    return {
      text: JSON.stringify(listing, null, 2),
      structured: listing,
    };
  },
};

export default listRepositories;
