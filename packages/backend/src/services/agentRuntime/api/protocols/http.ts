// Shared HTTP plumbing for the format adapters: where the endpoints are, one request with a
// timeout, status → failure code, and server-sent events.
import { ProtocolError, type ProtocolFailCode } from "./types.js";

const REQUEST_TIMEOUT_MS = 180_000;

/** The service root the endpoints hang off. A base address that already names an API version
 *  (".../v1", ".../v1beta/x") is used as written; a bare host gets "/v1". */
export function apiRoot(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new ProtocolError("bad_request"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProtocolError("bad_request");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${/(^|\/)v\d+[a-z]*(\/|$)/.test(path) ? path : `${path}/v1`}`;
}

/** Status → the short code. The body is read only to tell a billing refusal from a bad request. */
export function failCodeForStatus(status: number, body: string): ProtocolFailCode {
  if (status === 401 || status === 403) return "credential_rejected";
  if (status === 402) return "billing_error";
  if (status === 429) return /quota|billing|credit|insufficient/i.test(body) ? "billing_error" : "rate_limited";
  if (status === 404) return "model_unavailable";
  if (status === 400 || status === 422) return /credit balance|billing|insufficient|quota/i.test(body) ? "billing_error" : "bad_request";
  if (status >= 500) return "api_unavailable";
  return "api_error";
}

/** One request. A non-2xx answer or a failure to connect becomes a ProtocolError; nothing of the reply text escapes. */
export async function send(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method, signal,
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
    });
  } catch {
    throw new ProtocolError(init.signal?.aborted ? "stopped" : "api_unreachable");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ProtocolError(failCodeForStatus(response.status, text));
  }
  return response;
}

export async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new ProtocolError("api_error"); }
}

/** The `data:` payloads of a server-sent-event body, parsed as JSON, until "[DONE]" or the end. */
export async function* sseData(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) throw new ProtocolError("api_error");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = function* (final: boolean): Generator<unknown> {
    let at: number;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0 || (final && buffer.trim() !== "")) {
      const end = at >= 0 ? at : buffer.length;
      const event = buffer.slice(0, end);
      buffer = at >= 0 ? buffer.slice(end).replace(/^\r?\n\r?\n/, "") : "";
      const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { buffer = ""; return; }
      try { yield JSON.parse(data); } catch { throw new ProtocolError("api_error"); }
    }
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { throw new ProtocolError(signal?.aborted ? "stopped" : "api_unreachable"); }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      yield* take(false);
    }
    buffer += decoder.decode();
    yield* take(true);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
