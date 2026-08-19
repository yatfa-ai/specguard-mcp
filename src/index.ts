export { createServer, SERVER_NAME, SERVER_VERSION, type CreateServerOptions } from "./server.js";
// `requireUserApiConfig` is re-exported beside `requireApiConfig` rather than
// left behind it: the two are one seam with two credentials, and a consumer that
// can name only half of it would have to deep-import past this entrypoint to
// reach the other — the same unnameable-but-typed state `test/index.test.ts`
// exists to keep out of the error taxonomy.
export {
  loadConfig,
  requireApiConfig,
  requireUserApiConfig,
  tokenise,
  type ApiConfig,
  type ApiKeyVariable,
  type Config,
  type Credential,
} from "./config.js";
export { ApiError, ArgumentError, CommandError, ConfigError, SpecGuardMcpError } from "./errors.js";
export { TOOLS } from "./tools/index.js";
export type { ToolContext, ToolDefinition, ToolResult } from "./tools/types.js";
