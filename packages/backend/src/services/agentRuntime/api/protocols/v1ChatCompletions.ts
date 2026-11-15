// The "/v1/chat/completions" format: system/user/assistant/tool messages, function tools, usage in prompt/completion tokens.
// Most hosted services and local model servers speak it.
import { apiRoot, isJsonObject, readJson, send, sseData } from "./http.js";
import {
  ProtocolError, type ProtocolClient, type ProviderModel, type ServiceTarget, type ToolCall, type Turn, type TurnOptions, type TurnRequest, type TurnResult,
} from "./types.js";

const headers = (apiKey: string) => ({ authorization: `Bearer ${apiKey}` });

function toMessages(system: string, turns: Turn[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (turn.role === "user") out.push({ role: "user", content: turn.text });
    else if (turn.role === "tool") for (const r of turn.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `Error: ${r.text}` : r.text });
    else {
      out.push({
        role: "assistant", content: turn.text || null,
        ...(turn.toolCalls.length > 0
          ? { tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
    }
  }
  return out;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => (isJsonObject(part) && typeof part.text === "string" ? [part.text] : [])).join("");
  return "";
}

function parseArguments(raw: unknown): { input: unknown; bad: boolean } {
  if (isJsonObject(raw)) return { input: raw, bad: false };
  if (typeof raw !== "string" || raw.trim() === "") return { input: {}, bad: false };
  try {
    const parsed = JSON.parse(raw);
    return isJsonObject(parsed) ? { input: parsed, bad: false } : { input: {}, bad: true };
  } catch { return { input: {}, bad: true }; }
}

/** A finished completion object (or a stream assembled into one) → a turn result. */
function normalize(body: unknown): TurnResult {
  if (!isJsonObject(body) || !Array.isArray(body.choices) || !isJsonObject(body.choices[0]) || !isJsonObject(body.choices[0].message)) throw new ProtocolError("api_error");
  const choice = body.choices[0];
  const message = choice.message as Record<string, unknown>;
  const toolCalls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((c, i) => {
    if (!isJsonObject(c) || !isJsonObject(c.function) || typeof c.function.name !== "string") return [];
    const { input, bad } = parseArguments(c.function.arguments);
    return [{ id: typeof c.id === "string" && c.id ? c.id : `call_${i}`, name: c.function.name, input, ...(bad ? { badArguments: true } : {}) }];
  });
  const text = contentText(message.content).trim();
  const finish = String(choice.finish_reason);
  const stop: TurnResult["stop"] = toolCalls.length > 0 ? "tool_use"
    : finish === "length" ? "max_tokens"
    : finish === "content_filter" || (!text && typeof message.refusal === "string" && message.refusal !== "") ? "refusal" : "end";
  const usage = isJsonObject(body.usage) ? body.usage : {};
  const cached = isJsonObject(usage.prompt_tokens_details) ? num(usage.prompt_tokens_details.cached_tokens) : 0;
  return {
    text, toolCalls, stop,
    usage: { input: Math.max(0, num(usage.prompt_tokens) - cached), output: num(usage.completion_tokens), cacheRead: cached, cacheWrite: 0 },
    searchQueryLengths: [], raw: { message },
  };
}

type PartialCall = { id: string; name: string; arguments: string };

async function assembleStream(response: Response, options: TurnOptions): Promise<unknown> {
  let content = "";
  let finish: unknown = null;
  let usage: unknown = {};
  const calls: PartialCall[] = [];
  for await (const chunk of sseData(response, options.signal)) {
    if (!isJsonObject(chunk)) continue;
    if (isJsonObject(chunk.error)) throw new ProtocolError("api_error");
    if (isJsonObject(chunk.usage)) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isJsonObject(choice)) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    if (!isJsonObject(choice.delta)) continue;
    const delta = contentText(choice.delta.content);
    if (delta) { content += delta; options.onText?.(delta); }
    for (const call of Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []) {
      if (!isJsonObject(call)) continue;
      const at = typeof call.index === "number" ? call.index : calls.length;
      const slot = (calls[at] ??= { id: "", name: "", arguments: "" });
      if (typeof call.id === "string" && call.id) slot.id = call.id;
      if (isJsonObject(call.function)) {
        if (typeof call.function.name === "string") slot.name += call.function.name;
        if (typeof call.function.arguments === "string") slot.arguments += call.function.arguments;
      }
    }
  }
  const tool_calls = calls.filter(Boolean).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
  return { choices: [{ finish_reason: finish, message: { content, ...(tool_calls.length > 0 ? { tool_calls } : {}) } }], usage };
}

export function chatCompletionsClient(target: ServiceTarget): ProtocolClient {
  const root = apiRoot(target.baseUrl);
  return {
    protocol: "v1_chat_completions",
    supportsWebSearch: false,
    async listModels(options) {
      const body = await readJson(await send(`${root}/models`, { method: "GET", headers: headers(target.apiKey), signal: options?.signal }));
      if (!isJsonObject(body) || !Array.isArray(body.data)) throw new ProtocolError("api_error");
      return body.data.flatMap((m): ProviderModel[] => (isJsonObject(m) && typeof m.id === "string"
        ? [{ id: m.id, display_name: m.id, lifecycle: "active", web_search: false }] : []));
    },
    async turn(request: TurnRequest, options: TurnOptions = {}) {
      const stream = options.onText !== undefined;
      const response = await send(`${root}/chat/completions`, {
        method: "POST", headers: headers(target.apiKey), signal: options.signal,
        body: {
          model: request.model, max_tokens: request.maxOutputTokens, messages: toMessages(request.system, request.turns),
          ...(request.tools.length > 0
            ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        },
      });
      return normalize(stream ? await assembleStream(response, options) : await readJson(response));
    },
  };
}
