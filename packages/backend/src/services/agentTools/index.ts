// Agent tools: the registry that IS the agent permission boundary (what an
// MCP client or harness may call), the token access levels offered when minting
// a token, and the per-actor rate limiter tool calls go through.
// Token tool scope and ScopeError live in spine/toolScope.ts so the spine
// can refuse a token without loading this registry.
export { registerTool, gateCoreAgentTools, listTools, toolsAllowedFor, toolsOfferedIn, getTool, callTool, callPrompt, auditedToolArgs } from "./registry.js";
export type { AgentTool, ToolAccess } from "./types.js";
export { TOKEN_ACCESS_LEVELS, isTokenAccess, toolsForAccess } from "./templates.js";
export { RateLimitError, PgRateLimiter, setRateLimiter, checkRateLimit } from "./rateLimit.js";
export { READ_ONLY_TOOL_NAMES } from "./readOnlyTools.js";
export { mcpSafeError } from "./safeError.js";
export { readableNote, type ReadableNote } from "./readableNote.js";
