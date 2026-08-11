import { requireApiConfig, type ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";

/**
 * The SpecGuard HTTP client — a Bearer key and a path, and nothing else.
 *
 * Authorization is enforced by the deployment (`Api::BaseController`), never
 * here: this carries the operator's key and reports what came back. The bridge
 * adds no credentials of its own and makes no access decisions, so there is no
 * second place for the permission model to be got wrong.
 */
export async function getJson(
  api: ApiConfig,
  path: string,
  query: Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  const url = new URL(`${api.endpoint}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetchWithTimeout(url, api, fetchImpl);
  const body = await response.text();

  if (!response.ok) throw describeFailure(response.status, body, api);

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(
      `${api.endpoint} answered ${response.status} but the body was not JSON. ` +
        `Check that ${api.endpointVariable} points at a SpecGuard deployment and not, say, a proxy ` +
        "or login page.",
      response.status,
    );
  }
}

async function fetchWithTimeout(
  url: URL,
  api: ApiConfig,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), api.requestTimeoutMs);

  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        Accept: "application/json",
        "User-Agent": "specguard-mcp",
      },
      signal: controller.signal,
    });
  } catch (error) {
    // A transport failure and a refusal are different problems with different
    // fixes, and "fetch failed" names neither. The endpoint is echoed because
    // the commonest cause by far is that it is wrong — and the variable is named
    // from the config rather than spelled out here, so an operator who set
    // SPECGUARD_URL is not sent to fix a variable they never set.
    if (controller.signal.aborted) {
      throw new ApiError(`${api.endpoint} did not respond within ${api.requestTimeoutMs}ms.`);
    }

    throw new ApiError(
      `Could not reach ${api.endpoint}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Check ${api.endpointVariable} and that the deployment is reachable from this machine.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The status turned into something the agent can act on.
 *
 * 401 is called out by name because it is the one an operator will actually
 * hit, and because SpecGuard answers it deliberately flat — "a valid Bearer API
 * key is required", with no detail about why — so the useful half of the
 * diagnosis has to be supplied from this side.
 */
function describeFailure(status: number, body: string, api: ApiConfig): ApiError {
  if (status === 401) {
    return new ApiError(
      "SpecGuard rejected the API key (401). SPECGUARD_API_KEY must be an sgk_… key issued by " +
        `${api.endpoint} for the repository you are asking about — keys are per-repository, and a ` +
        "revoked key reads the same as a wrong one.",
      status,
    );
  }

  if (status === 404) {
    return new ApiError(
      `${api.endpoint} has no such endpoint (404). Check that ${api.endpointVariable} is the ` +
        "deployment's root URL, without a path.",
      status,
    );
  }

  return new ApiError(
    `SpecGuard answered ${status}${body.trim() === "" ? "" : `: ${body.trim().slice(0, 500)}`}`,
    status,
  );
}

export { requireApiConfig };
