// The one door to a model service: give it an address, a key and (optionally) the format, and get a
// ProtocolClient. Everything provider-specific in the backend lives in this folder.
import { config } from "../../../../config.js";
import { apiRoot, isJsonObject, readJson, send } from "./http.js";
import { chatCompletionsClient } from "./v1ChatCompletions.js";
import { messagesClient } from "./v1Messages.js";
import { ProtocolError, type ProtocolClient, type ProtocolId, type ServiceTarget } from "./types.js";

export * from "./types.js";

/** ONDEN_AI_BASE_URL_OVERRIDE (older name ONDEN_ANTHROPIC_BASE_URL, still read) points every key at
 *  one service; tests use it to reach a fake server and a deployment normally leaves it unset. */
export function baseUrlOverride(): string | undefined {
  return config.str("ONDEN_AI_BASE_URL_OVERRIDE") || config.str("ONDEN_ANTHROPIC_BASE_URL") || undefined;
}

export function protocolClient(protocol: ProtocolId, target: ServiceTarget): ProtocolClient {
  const resolved = { ...target, baseUrl: baseUrlOverride() ?? target.baseUrl };
  return protocol === "v1_messages" ? messagesClient(resolved) : chatCompletionsClient(resolved);
}

/** Which format does this service speak? Asks `{address}/models` once, with both ways of sending the
 *  key, and reads the shape of the answer. Null when it cannot tell: the person then picks a format. */
export async function detectProtocol(target: ServiceTarget, options?: { signal?: AbortSignal }): Promise<ProtocolId | null> {
  const url = `${apiRoot(baseUrlOverride() ?? target.baseUrl)}/models`;
  let body: unknown;
  try {
    body = await readJson(await send(url, {
      method: "GET", signal: options?.signal,
      headers: { authorization: `Bearer ${target.apiKey}`, "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" },
    }));
  } catch (error) {
    // A refused key or an unreachable address is not "unknown format": say what happened.
    if (error instanceof ProtocolError && (error.code === "credential_rejected" || error.code === "api_unreachable" || error.code === "stopped")) throw error;
    return null;
  }
  if (!isJsonObject(body) || !Array.isArray(body.data)) return null;
  const first = body.data.find(isJsonObject);
  // /v1/messages lists models as {type:"model", display_name} with paging fields; chat completions as {object:"model"}.
  if (first ? first.type === "model" && typeof first.display_name === "string" : "has_more" in body && "first_id" in body) return "v1_messages";
  if (first ? first.object === "model" : body.object === "list") return "v1_chat_completions";
  return null;
}
