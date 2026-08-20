import { getJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
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
 * which is why it ships alone. The registry's standing rule (`tools/index.ts`)
 * is that a tool in `tools/list` is a promise an agent acts on, so the other
 * user-scoped endpoints wait for the transport they need: `POST /api/v1/repositories`
 * EXISTS on the platform today, and `getJson` hardcodes `method: "GET"` and
 * takes no body, so registering a repository is blocked on a write transport
 * rather than on a missing endpoint. That transport belongs with the first write
 * tool, where it can be designed against a real body and a real 4xx surface.
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
 * == No arguments, because the credential is the whole question
 *
 * The endpoint takes no parameters: the person the `sgu_` key speaks for is the
 * entire scope of the answer, and `Repository.accessible_by` — owned UNION
 * shared-through-a-membership — is the platform's read-side boundary rather
 * than a filter this bridge could widen or narrow. A repository the person
 * neither owns nor is a member of never enters the response, so there is
 * nothing here for a parameter to select and nothing an argument could reach.
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
 * ordering it has not designed. It is stated here for the same reason the other
 * tool states its orders: a list whose order is a coincidence and a list whose
 * order is a contract look identical in a response body.
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
    "Ordered by `full_name` ascending, which is stable across calls. " +
    "The set is exactly what this person may see — a repository they neither own nor were given " +
    "access to is absent rather than filtered, so an empty list means no access, never an error. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), which is a DIFFERENT credential from the " +
    "sgk_… repository key get_repository_overview reads; SpecGuard refuses each in the other's " +
    "place.",
  inputSchema: {
    type: "object",
    // No properties, deliberately — see this file's header. Still CLOSED rather
    // than merely empty: `additionalProperties: false` is advertised in
    // `tools/list`, so a client that honours the schema REJECTS an invented
    // argument before the call is made. Nothing on this side refuses it —
    // `server.ts` forwards `arguments` unvalidated and `run` ignores them — so
    // an open schema would have the argument silently dropped and the call
    // answered as if it had been honoured.
    additionalProperties: false,
  },

  async run(_args, context): Promise<ToolResult> {
    const api = requireUserApiConfig(context.config);

    const listing = await getJsonObject(api, "/api/v1/repositories", {}, context.fetch);

    return {
      text: JSON.stringify(listing, null, 2),
      structured: listing,
    };
  },
};

export default listRepositories;
