import { getJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `GET /api/v1/repositories/registrable` as a tool — shipped today in the
 * platform (`specguard/config/routes.rb:117`, served by
 * `Api::V1::UserRepositoriesController#registrable`).
 *
 * == What it answers, and why `list_repositories` does not
 *
 * `list_repositories` reports what is already registered; this reports what
 * COULD be — the repositories the registration gate would consult, read out
 * loud in advance. It exists so an agent can pick a `full_name` for
 * `add_repository` from a real answer rather than by guessing, and so a
 * `has already been taken` refusal can be explained rather than merely
 * retried.
 *
 * == Two controller decisions the description carries, because both are
 *    counter-intuitive and both are stated in the controller's own comments
 *
 * `registered` is asked of `Repository` GLOBALLY, not of what this person can
 * open. The controller says why: a repository somebody ELSE registered still
 * refuses this person's POST with `has already been taken`, so a reading
 * scoped to what they can see would mark it `registered: false` and send them
 * at a name that cannot be registered by anyone. An entry is therefore
 * MARKED, not excluded — `registered: true` is the answer to "why did my POST
 * say has already been taken".
 *
 * And a name appearing here is NOT a promise the write will succeed. This is
 * the set the gate would consult at the moment of the read; the repository may
 * be registered by someone else between the two calls.
 *
 * == The modal first answer is a 403, and that is why `describeFailure` grew
 *
 * `#registrable` fails closed on the two states `GrantVerifier` refuses on and
 * renders `status: :forbidden` — NOT the 400 path the other refusals use. A
 * nil grant is, in the controller's own words, "an ordinary state and not an
 * error: it is every person who has not opened SpecGuard in a browser since
 * this shipped" — so the 403 is the modal first answer this tool gives, and
 * the sentence it carries (sign in, reconnect GitHub, retry) reaches the agent
 * through the 403 branch in `specguard-api.ts`, which this tool is the reason
 * for. On refusal the body still carries `grant`: `null` when there never was
 * one, populated with `stale: true` when it lapsed — "yours lapsed four days
 * ago" is a different fact from "you never had one", and the tool description
 * is where an agent learns to branch on it.
 *
 * == No arguments, for the same reason `list_repositories` has none
 *
 * The credential is the whole of the scope. The endpoint takes no parameters,
 * and nothing an argument could select reaches this answer.
 */
const registrableRepositories: ToolDefinition = {
  name: "registrable_repositories",
  title: "Registrable repositories",
  description:
    "Lists the GitHub repositories the person behind this server's user API key could register " +
    "with SpecGuard — the set the registration gate would consult, read out in advance, so an " +
    "agent can pick a `full_name` for `add_repository` from a real answer rather than by " +
    "guessing. Each entry carries `full_name` and `registered`. `registered` is asked GLOBALLY, " +
    "not just of this person's own repositories: an entry marked `registered: true` was " +
    "registered by SOMEBODY — possibly someone else — and a POST naming it will be refused with " +
    "`has already been taken`, which is exactly the question this flag answers. Entries are " +
    "marked, not excluded, for that reason. The response also carries a `grant` block " +
    "(`captured_at`, `expires_at`, `stale`) describing the stored record of this person's GitHub " +
    "permissions. A MISSING or STALE grant is not an error — it is every person who has not " +
    "opened SpecGuard in a browser recently — and the call then answers 403 with SpecGuard's own " +
    "sentence naming the fix: sign in to SpecGuard in a browser and reconnect GitHub, then try " +
    "again. On that refusal the body's `grant` distinguishes the two cases: `grant: null` means " +
    "there never was one (first-time setup), a populated grant with `stale: true` means an " +
    "existing connection lapsed (same remedy, likely faster to complete) — branch on it before " +
    "telling the person what to do. A name appearing in the list is not a promise the write " +
    "will succeed: someone may register it between this read and the POST. Ordered by " +
    "`full_name` ascending, which is stable across calls. Needs SPECGUARD_USER_API_KEY (an " +
    "sgu_… key), the same credential `list_repositories` and `add_repository` read and a " +
    "DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    // No properties, deliberately — see this file's header. Still CLOSED rather
    // than merely empty, for the reason `list-repositories.ts` gives inline:
    // `server.ts` forwards `arguments` unvalidated and `run` ignores them, so
    // an open schema would have an invented argument silently dropped and the
    // call answered as if it had been honoured.
    additionalProperties: false,
  },

  async run(_args, context): Promise<ToolResult> {
    const api = requireUserApiConfig(context.config);

    const listing = await getJsonObject(
      api,
      "/api/v1/repositories/registrable",
      {},
      context.fetch,
    );

    return {
      text: JSON.stringify(listing, null, 2),
      structured: listing,
    };
  },
};

export default registrableRepositories;
