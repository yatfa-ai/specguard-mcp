import { postJsonObject, requireUserApiConfig } from "../support/specguard-api.js";
import { requireString } from "./args.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * `POST /api/v1/repositories` as a tool — shipped today in the platform
 * (`specguard/config/routes.rb`, `Api::V1::UserRepositoriesController#create`).
 *
 * == The first tool here that WRITES, and what that changed
 *
 * Everything before this read. The registry's standing rule is that a tool in
 * `tools/list` is a promise an agent will act on, and this endpoint has existed
 * on the platform for some time — what was missing was on THIS side: `getJson`
 * hardcoded `method: "GET"` and took no body. `tools/index.ts` and
 * `list-repositories.ts` both said so, and said the transport should land with
 * the first write tool so it could be designed against a real request body and a
 * real 4xx surface rather than invented for a caller that did not exist. This is
 * that tool, and `postJson`/`postJsonObject` are that transport.
 *
 * == The request body is top-level, because the caller is an agent
 *
 * `{"github_full_name": "org/repo"}`, not `{"repository": {…}}`. The controller
 * permits it that way and says why: this is a JSON API being driven by an agent,
 * not a Rails form being submitted by a browser, and the top-level shape is what
 * a caller writing curl by hand will send.
 *
 * == The format is NOT re-validated here, deliberately
 *
 * `Repository` validates `org/repo` itself, and a refusal now arrives through
 * the 400 branch in `describeFailure` in SpecGuard's own words. A second format
 * rule on this side is exactly what "a thin client that reshapes its upstream is
 * not thin" forbids — it would be a rule with no owner, free to drift from the
 * one that actually decides, and its divergence would surface as this bridge
 * refusing a name the platform would have accepted. Checking that `full_name` is
 * a present, non-blank string is the whole of the bridge's business: that is a
 * shape check, which is why it is `requireString` from `args.ts` and not a
 * hand-rolled one here.
 *
 * == The MODAL first answer is a 400, and it is the useful one
 *
 * `RepositoryRegistration::GrantVerifier` fails closed on a grant that is
 * missing or stale, which is every person who has not opened SpecGuard in a
 * browser since this shipped — the controller records that this is "an ordinary
 * state and not an error". The sentence that comes back names the operator's
 * exact next move (sign in, reconnect GitHub, retry), and reaching the agent
 * intact is what the 400 branch in `specguard-api.ts` is for.
 *
 * == Why the description carries a hazard paragraph
 *
 * `types.ts` calls the description "prompt material, not documentation … the
 * entire basis on which a model decides whether to call the tool". This tool is
 * NOT idempotent and its 201 carries a reveal-once token, so an agent that
 * learns those facts by hitting them has already lost the token. They are stated
 * where they are read BEFORE the call is committed to, rather than left to be
 * discovered from a failure.
 */
const addRepository: ToolDefinition = {
  name: "add_repository",
  title: "Add repository",
  description:
    "Registers a GitHub repository with SpecGuard for the person behind this server's user API " +
    "key, and returns the repository along with its first CI API key. " +
    "Takes `full_name` as `org/repo` — the same handle `list_repositories` reports and every other " +
    "SpecGuard surface names a repository by. " +
    "On success the response carries a `repository` block (`id`, `full_name`, `name`, " +
    "`registered_at`) and an `api_key` block (`name`, `token`, `hint`, `created_at`). " +
    "⚠️ `api_key.token` is shown THIS ONCE AND NEVER AGAIN — nothing stores it and no endpoint can " +
    "re-serve it, so hand it to the user in your reply rather than assuming it can be fetched " +
    "later. " +
    "⚠️ This tool is NOT idempotent and it WRITES. If the call times out (SPECGUARD_TIMEOUT_MS) " +
    "the registration may still have succeeded on the server, taking its one-time token with it; " +
    "retrying then fails with `has already been taken`, which is the honest answer, and the " +
    "recovery is SpecGuard's API-keys page in a browser. Do not retry a timeout blindly. " +
    "Requires a CURRENT record of the caller's GitHub permissions, which only a browser session " +
    "creates: a person who has not signed in to SpecGuard and connected GitHub recently is refused " +
    "with a message saying exactly that, and the fix is theirs to perform in a browser — no " +
    "argument to this tool can substitute for it. The repository must also be one the SpecGuard " +
    "GitHub App is installed on and that this person administers. " +
    "Needs SPECGUARD_USER_API_KEY (an sgu_… key), the same credential `list_repositories` reads " +
    "and a DIFFERENT one from the sgk_… repository key `get_repository_overview` uses.",
  inputSchema: {
    type: "object",
    properties: {
      full_name: {
        type: "string",
        description:
          "The repository to register, as `org/repo` (for example `acme/billing`) — the same " +
          "handle `list_repositories` reports. Not a URL and not a bare repository name. " +
          "SpecGuard validates the format and refuses an unusable one in its own words.",
      },
    },
    required: ["full_name"],
    // Closed for the reason `list_repositories` states: `server.ts` forwards
    // `arguments` unvalidated, so an open schema would let a misspelled argument
    // be dropped silently and the call answered as though it had been honoured.
    // On a WRITE that is worse than on a read — the call still registers
    // something, just not what the agent believed it was asking for.
    additionalProperties: false,
  },

  async run(args, context): Promise<ToolResult> {
    // Argument shape FIRST, before the config is resolved and before anything is
    // sent: a malformed call is the one failure the agent can fix unaided, and
    // it must not cost a write attempt to discover.
    const fullName = requireString(args["full_name"], "full_name");

    const api = requireUserApiConfig(context.config);

    const registration = await postJsonObject(
      api,
      "/api/v1/repositories",
      { github_full_name: fullName },
      context.fetch,
    );

    // Passed through exactly as `list_repositories` passes its listing through.
    // It matters more here: `api_key.token` exists nowhere else, so any reshaping
    // on this hop is a value that cannot be recovered rather than a field that
    // can be re-fetched.
    return {
      text: JSON.stringify(registration, null, 2),
      structured: registration,
    };
  },
};

export default addRepository;
