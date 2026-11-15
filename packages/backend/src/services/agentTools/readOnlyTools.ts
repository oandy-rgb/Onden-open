// Agent tools whose call changes nothing. Their AGENT_TOOL_CALLED audit rows
// stay in domain_events but History does not list them: an MCP client that
// polls getNode/searchNodes would bury every real change (routes/events.ts).
// A tool not named here is treated as a write, so a new tool shows up in
// History until it is classified; a registry test keeps the two in step.
export const READ_ONLY_TOOL_NAMES: readonly string[] = [
  "searchNodes",
  "getNode",
  "getAttachment",
  "queryView",
  "listChildren",
  "listSpaces",
  "listSuggestions",
  "getSlides",
  "loadSkill",
  "semanticSearch",
  "suggestLinks",
  "listMySessions",
  "getSessionLog",
];
