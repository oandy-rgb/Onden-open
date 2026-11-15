// The neutral face of "call an AI service". The run loop (../run.ts) talks to a
// ProtocolClient and never to a provider: one call is one model turn, tools are
// described as JSON Schema, usage is counted in tokens, and every failure is one
// of the short codes below (the provider's own error text is dropped, never logged).
//
// Only this folder may name a provider, its SDK or its wire format
// (test/guards/aiVendorNames.guard.test.ts). Add a format by writing one more
// adapter file and listing it in index.ts.

/** The wire format a service speaks, named by the path it serves. */
import { CodedStatusError } from "../../../../statusError.js";

export type ProtocolId = "v1_messages" | "v1_chat_completions";
export const PROTOCOL_IDS: readonly ProtocolId[] = ["v1_messages", "v1_chat_completions"];
export const isProtocolId = (value: unknown): value is ProtocolId => PROTOCOL_IDS.includes(value as ProtocolId);

/** The failure codes an adapter may raise: the codes agent_sessions.fail_code already knows. */
export type ProtocolFailCode =
  | "stopped" | "credential_rejected" | "rate_limited" | "model_unavailable" | "billing_error"
  | "bad_request" | "api_unreachable" | "api_unavailable" | "api_error";

/** A failed call to a service. The status is only the base class's; the code is what callers read. */
export class ProtocolError extends CodedStatusError {
  constructor(readonly code: ProtocolFailCode) { super(422, code, code); }
}

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown; /** The service sent arguments that were not valid JSON. */ badArguments?: boolean };
export type ToolResult = { callId: string; text: string; isError: boolean };

/** One step of the conversation. `raw` is what the adapter itself returned for an
 *  assistant turn, handed back untouched so a service that needs its own blocks
 *  (search results, say) gets them again. */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export type TurnRequest = {
  model: string;
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  /** Ask for the service's own web search. Ignored by a format that has none. */
  webSearch: boolean;
};

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type TurnResult = {
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  usage: TurnUsage;
  /** Query lengths of web searches the service ran itself (the query can carry note text, so only its length). */
  searchQueryLengths: number[];
  raw: unknown;
};

export type ProviderModel = { id: string; display_name: string; lifecycle: "active" | "deprecated" | "retired"; web_search: boolean };

export type TurnOptions = { signal?: AbortSignal; /** Called with each piece of text as it arrives; asking for it makes the call a streaming one. */ onText?: (delta: string) => void };

export interface ProtocolClient {
  readonly protocol: ProtocolId;
  listModels(options?: { signal?: AbortSignal }): Promise<ProviderModel[]>;
  turn(request: TurnRequest, options?: TurnOptions): Promise<TurnResult>;
  /** Can this format run the service's own web search at all? */
  readonly supportsWebSearch: boolean;
}

export type ServiceTarget = { baseUrl: string; apiKey: string };
