// The "/v1/messages" format: content blocks, tool_use / tool_result, usage in input/output tokens.
import { apiRoot, isJsonObject, readJson, send, sseData } from "./http.js";
import {
  ProtocolError, type ProtocolClient, type ProviderModel, type ServiceTarget, type ToolCall, type TurnOptions, type TurnRequest, type TurnResult, type Turn,
} from "./types.js";

const VERSION_HEADER = "2023-06-01";
const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };

type Block = Record<string, unknown>;

const headers = (apiKey: string) => ({ "x-api-key": apiKey, "anthropic-version": VERSION_HEADER });

function toMessages(turns: Turn[]): Array<{ role: "user" | "assistant"; content: unknown }> {
  return turns.map((turn) => {
    if (turn.role === "user") return { role: "user" as const, content: turn.text };
    if (turn.role === "tool") {
      return { role: "user" as const, content: turn.results.map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.text, ...(r.isError ? { is_error: true } : {}) })) };
    }
    if (isJsonObject(turn.raw) && Array.isArray(turn.raw.content)) return { role: "assistant" as const, content: turn.raw.content };
    return {
      role: "assistant" as const,
      content: [
        ...(turn.text ? [{ type: "text", text: turn.text }] : []),
        ...turn.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
      ],
    };
  });
}

const STOPS: Record<string, TurnResult["stop"]> = {
  end_turn: "end", stop_sequence: "end", tool_use: "tool_use", pause_turn: "tool_use", max_tokens: "max_tokens", refusal: "refusal",
};

/** A finished message object (what a non-streaming call returns, or a stream assembled into one) → a turn result. */
function normalize(message: unknown): TurnResult {
  if (!isJsonObject(message) || !Array.isArray(message.content) || !isJsonObject(message.usage)) throw new ProtocolError("api_error");
  const blocks = message.content.filter(isJsonObject) as Block[];
  const toolCalls: ToolCall[] = blocks.filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
    .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input ?? {} }));
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const usage = message.usage;
  return {
    text: blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n").trim(),
    toolCalls,
    stop: STOPS[String(message.stop_reason)] ?? (toolCalls.length > 0 ? "tool_use" : "end"),
    usage: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens) },
    searchQueryLengths: blocks.filter((b) => b.type === "server_tool_use" && b.name === "web_search")
      .map((b) => (isJsonObject(b.input) && typeof b.input.query === "string" ? b.input.query.length : 0)),
    raw: { content: blocks },
  };
}

const STREAM_ERRORS: Record<string, "credential_rejected" | "rate_limited" | "api_unavailable" | "bad_request"> = {
  authentication_error: "credential_rejected", permission_error: "credential_rejected", rate_limit_error: "rate_limited",
  overloaded_error: "api_unavailable", invalid_request_error: "bad_request",
};

/** Server-sent events → the message they add up to. Text goes to `onText` as it arrives. */
async function assembleStream(response: Response, options: TurnOptions): Promise<unknown> {
  const message: { content: Block[]; stop_reason: string | null; usage: Record<string, unknown> } = { content: [], stop_reason: null, usage: {} };
  const partialJson = new Map<number, string>();
  for await (const event of sseData(response, options.signal)) {
    if (!isJsonObject(event)) continue;
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "message_start":
        if (isJsonObject(event.message) && isJsonObject(event.message.usage)) message.usage = { ...event.message.usage };
        break;
      case "content_block_start":
        if (isJsonObject(event.content_block)) message.content[index] = { ...event.content_block };
        break;
      case "content_block_delta": {
        const block = message.content[index];
        if (!block || !isJsonObject(event.delta)) break;
        if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
          block.text = `${typeof block.text === "string" ? block.text : ""}${event.delta.text}`;
          options.onText?.(event.delta.text);
        } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
          partialJson.set(index, (partialJson.get(index) ?? "") + event.delta.partial_json);
        }
        break;
      }
      case "content_block_stop": {
        const json = partialJson.get(index);
        const block = message.content[index];
        if (block && json !== undefined) {
          try { block.input = json.trim() === "" ? {} : JSON.parse(json); } catch { throw new ProtocolError("api_error"); }
        }
        break;
      }
      case "message_delta":
        if (isJsonObject(event.delta) && typeof event.delta.stop_reason === "string") message.stop_reason = event.delta.stop_reason;
        if (isJsonObject(event.usage)) message.usage = { ...message.usage, ...event.usage };
        break;
      case "error": {
        const type = isJsonObject(event.error) ? String(event.error.type) : "";
        throw new ProtocolError(STREAM_ERRORS[type] ?? "api_error");
      }
    }
  }
  message.content = message.content.filter(Boolean);
  return message;
}

export function messagesClient(target: ServiceTarget): ProtocolClient {
  const root = apiRoot(target.baseUrl);
  return {
    protocol: "v1_messages",
    supportsWebSearch: true,
    async listModels(options) {
      const models: ProviderModel[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const url: string = `${root}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
        const body = await readJson(await send(url, { method: "GET", headers: headers(target.apiKey), signal: options?.signal }));
        if (!isJsonObject(body) || !Array.isArray(body.data)) throw new ProtocolError("api_error");
        for (const m of body.data) {
          if (!isJsonObject(m) || typeof m.id !== "string") continue;
          const caps = isJsonObject(m.capabilities) && isJsonObject(m.capabilities.server_tools) ? m.capabilities.server_tools : null;
          models.push({
            id: m.id, display_name: typeof m.display_name === "string" ? m.display_name : m.id,
            lifecycle: m.lifecycle === "retired" || m.lifecycle === "deprecated" ? m.lifecycle : "active",
            web_search: isJsonObject(caps?.web_search) && caps.web_search.supported === true,
          });
        }
        after = body.has_more === true && typeof body.last_id === "string" ? body.last_id : null;
        if (!after) break;
      }
      return models;
    },
    async turn(request: TurnRequest, options: TurnOptions = {}) {
      const stream = options.onText !== undefined;
      const tools: unknown[] = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      if (request.webSearch) tools.push(SEARCH_TOOL);
      const response = await send(`${root}/messages`, {
        method: "POST", headers: headers(target.apiKey), signal: options.signal,
        body: {
          model: request.model, max_tokens: request.maxOutputTokens, system: request.system, messages: toMessages(request.turns),
          ...(tools.length > 0 ? { tools } : {}), ...(stream ? { stream: true } : {}),
        },
      });
      return normalize(stream ? await assembleStream(response, options) : await readJson(response));
    },
  };
}
