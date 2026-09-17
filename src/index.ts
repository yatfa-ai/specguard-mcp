export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
// The require* helpers are re-exported together rather than left behind each
// other: they are one seam over one credential machinery, now with three
// variables and one credential-free sibling, and a consumer that can name only
// part of it would have to deep-import past this entrypoint to reach the rest
// — the same unnameable-but-typed state `test/index.test.ts` exists to keep
// out of the error taxonomy.
export {
  loadConfig,
  requireApiConfig,
  requireUserApiConfig,
  requireAgentApiConfig,
  requireUserOrAgentApiConfig,
  requireEndpointApiConfig,
  tokenise,
  type ApiConfig,
  type ApiKeyVariable,
  type Config,
  type Credential,
  type CredentialledApiConfig,
} from "./config.js";
export { ApiError, ArgumentError, CommandError, ConfigError, SpecGuardMcpError } from "./errors.js";
export { TOOLS } from "./tools/index.js";
export type { ToolContext, ToolDefinition, ToolResult } from "./tools/types.js";
