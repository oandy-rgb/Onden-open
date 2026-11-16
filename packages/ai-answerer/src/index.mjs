// What the desktop app and the tests import.
export { createClient, ProtocolError } from "./protocol.mjs";
export { runLoop, MAX_RUN_MS, DEADLINE_MARGIN_MS } from "./loop.mjs";
export { assemblePrompt, parseToolOutput } from "./prompt.mjs";
export { parseServerAddress } from "./address.mjs";
export { readConnectionCode } from "./keyFile.mjs";
export { createAdapters } from "./adapters/index.mjs";
export { createClaudeCodeAdapter, claudeArgs, mcpConfigJson, SAFETY_FLAGS } from "./adapters/claudeCode.mjs";
