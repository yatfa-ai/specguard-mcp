import { getJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
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
 * does not take a repository: its `sgk_` key IS the repository, so the question
 * "what may I ask about" has no answer anywhere in this server. This is that
 * answer, and it is the whole of what this tool does.
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
 * `get_repository_overview` uses, and that one refuses this key. Hence
 * `requireUserApiConfig` rather than `requireApiConfig`: the two are the same
 * function over different variables, and the `Credential` each carries is what
 * makes a 401 or an unset variable name the one the OPERATOR of this tool has
 * to go and fix. See `config.ts`.
 *
 * == The credential is the SCOPE, and the arguments narrow WITHIN it
 *
 * This file first shipped argument-less on a premise that has since rotted: it
 * said "the endpoint takes no parameters", because the person the `sgu_` key
 * speaks for was the entire scope of the answer. That stopped being true on
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
 * What has NOT changed is which side of the boundary the asks sit on.
 * `Repository.accessible_by` — owned UNION shared-through-a-membership — is
 * still the platform's read-side boundary, and the controller chains every ask
 * onto the relation that boundary already admitted
 * (`narrow_repositories(authorized_repositories, …)`): a repository the person
 * neither owns nor is a member of never ENTERS the relation, so no argument
 * here widens the answer — it can only narrow, or re-order, what the
 * credential already admits. Out-of-vocabulary values are the server's to
 * clamp, not ours: an unknown `role` or `sort` settles to the no-ask, never a
 * 400, which is also why a value that reaches the wire is passed through
 * verbatim rather than validated against a second vocabulary here.
 *
 * Blank is no ask, and so is undefined: `optionalString` returns `undefined`
 * for a blank value and `getJson` omits an `undefined` query entry, so
 * declining an ask and omitting the argument are the same wire request — the
 * established spelling in this codebase (`repository-overview.ts` states it
 * as build-don't-stringify), and the reason the no-argument request below is
 * byte-identical to the one this tool made before it had arguments at all.
 *
 * == The response is passed through, not re-modelled
 *
 * Same rule as every other tool here (`types.ts`: "A thin client that reshapes
 * its upstream is not thin"), and it has real content on this body. The
 * controller serves each entry as `id`, `full_name`, `name`, `registered_at`
 * and `role`, and says why: the first four are DELIBERATELY the same four
 * fields, under the same names, that `GET /api/v1/repository` serves in its own
 * `repository` block, so a client that has read one knows how to read the other.
 * Renaming or flattening anything here would spend that parity on the last hop.
 *
 * `role` is the field this surface adds — `"owner"` or `"member"` — because the
 * list MIXES repositories the person owns with repositories somebody shared
 * with them and no other field separates the two. An agent that will later
 * register keys or change settings needs to know which of these it may expect
 * to administer, so the value is named in the description rather than left to be
 * discovered from the data.
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
    "Lists the SpecGuard repositories the person behind this server's user API key may open — " +
    "the answer to \"what can I ask about\", which no other tool here can give, because every " +
    "other tool is already scoped to one repository by its key. " +
    "Each entry carries `id`, `full_name` (`org/repo`, and the handle every other surface names " +
    "a repository by), `name`, `registered_at` and `role`. " +
    "`role` is `owner` or `member`: the list mixes repositories this person owns with " +
    "repositories somebody shared with them, and nothing else distinguishes the two — read it " +
    "before assuming a repository is yours to administer. " +
    "Three optional asks narrow WITHIN that set — none of them can widen it — all optional, " +
    "composable on one call: `q` (case-insensitive substring on `full_name`), " +
    "`role: \"owned\"` or `\"shared\"` (one half of the owned/shared mix — note the ask is " +
    "spelled `owned`, not the response field's `owner`), and `sort: \"stale\"` (repositories " +
    "CI has never ingested a run for first, then least-recently-ingested, `full_name` " +
    "breaking ties). Omit them all and the request is the plain full list. " +
    "Ordered by `full_name` ascending unless `sort` asks otherwise, and stable across calls " +
    "either way. " +
    "The set is exactly what this person may see — a repository they neither own nor were given " +
    "access to is absent rather than filtered, so an empty list means no access, never an error. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), which is a DIFFERENT credential from the " +
    "sgk_… repository key get_repository_overview reads; SpecGuard refuses each in the other's " +
    "place.",
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
          "`\"owner\"` or `\"member\"`, but the ask is `owned`/`shared` — send `role: " +
          "\"owner\"` and you are not asking for anything. A client that honours this schema " +
          "cannot send it (the enum refuses it before the call); a client that bypasses the " +
          "schema gets the server's clamp, where any value outside `owned`/`shared` settles to " +
          "the no-ask and the full list is served — never an error. " +
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
    const api = requireUserApiConfig(context.config);

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
