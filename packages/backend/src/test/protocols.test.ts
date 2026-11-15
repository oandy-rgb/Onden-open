// The two wire-format adapters and the format detection, against fake HTTP servers (nothing reaches a real service).
// For each format: a plain reply, a tool call and its result going back, a streamed reply, token usage, and the
// failures that matter (key refused, too many requests, a reply in the wrong shape).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectProtocol, protocolClient, ProtocolError, type ProtocolId, type TurnRequest,
} from "../services/agentRuntime/api/protocols/index.js";

type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void;
const servers: Server[] = [];
async function serve(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const json = (res: ServerResponse, body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const sse = (res: ServerResponse, frames: unknown[], tail = "") => {
  res.setHeader("content-type", "text/event-stream");
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end(tail);
};

const request = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "m1", system: "be brief", turns: [{ role: "user", text: "hi" }], maxOutputTokens: 100, webSearch: false,
  tools: [{ name: "getNode", description: "read a note", inputSchema: { type: "object", properties: { id: { type: "string" } } } }], ...over,
});

const FORMATS: Array<{
  protocol: ProtocolId; path: string;
  text: (t: string, usage?: [number, number]) => unknown; tool: (name: string, input: object) => unknown;
  stream: (t: string) => unknown[]; models: unknown; authHeader: string;
}> = [
  {
    protocol: "v1_messages", path: "/v1/messages", authHeader: "x-api-key",
    text: (t, [i, o] = [10, 5]) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 3 } }),
    tool: (name, input) => ({ content: [{ type: "tool_use", id: "call_1", name, input }], stop_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2 } }),
    stream: (t) => [
      { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ...(t.match(/.{1,3}/gs) ?? []).map((part) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
      { type: "message_stop" },
    ],
    models: { data: [{ id: "m1", type: "model", display_name: "M one", capabilities: { server_tools: { web_search: { supported: true } } } }], has_more: false, first_id: "m1", last_id: "m1" },
  },
  {
    protocol: "v1_chat_completions", path: "/v1/chat/completions", authHeader: "authorization",
    text: (t, [i, o] = [10, 5]) => ({ choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage: { prompt_tokens: i + 3, completion_tokens: o, prompt_tokens_details: { cached_tokens: 3 } } }),
    tool: (name, input) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    stream: (t) => [
      ...(t.match(/.{1,3}/gs) ?? []).map((part) => ({ choices: [{ delta: { content: part } }] })),
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 6 } },
    ],
    models: { object: "list", data: [{ id: "m1", object: "model" }] },
  },
];

describe.each(FORMATS)("$protocol adapter", (f) => {
  it("a plain reply: text, token usage (cache reads counted apart), and the key sent the way the format expects", async () => {
    let seen: { headers: IncomingMessage["headers"]; body: any } | null = null;
    const url = await serve((req, body, res) => { seen = { headers: req.headers, body }; json(res, f.text("hello")); });
    const result = await protocolClient(f.protocol, { baseUrl: url, apiKey: "k-secret-1" }).turn(request());
    expect(result).toMatchObject({ text: "hello", stop: "end", toolCalls: [], usage: { input: 10, output: 5, cacheRead: 3 } });
    expect(seen!.headers[f.authHeader]).toContain("k-secret-1");
    expect(seen!.body.model).toBe("m1");
    expect(JSON.stringify(seen!.body)).toContain("be brief");
  });

  it("a tool call comes back as a call, and its result goes back to the service in the format's own shape", async () => {
    const bodies: any[] = [];
    const url = await serve((_req, body, res) => { bodies.push(body); json(res, bodies.length === 1 ? f.tool("getNode", { id: "n1" }) : f.text("done")); });
    const client = protocolClient(f.protocol, { baseUrl: url, apiKey: "k-secret-1" });
    const first = await client.turn(request());
    expect(first).toMatchObject({ stop: "tool_use", toolCalls: [{ id: "call_1", name: "getNode", input: { id: "n1" } }] });
    const second = await client.turn(request({
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw },
        { role: "tool", results: [{ callId: "call_1", text: "note text", isError: false }] },
      ],
    }));
    expect(second.text).toBe("done");
    const sent = JSON.stringify(bodies[1]);
    expect(sent).toContain("call_1");
    expect(sent).toContain("note text");
    // The tool list reached the service on both calls.
    expect(JSON.stringify(bodies[0])).toContain("getNode");
  });

  it("a streamed reply gives the text piece by piece, then the same result shape", async () => {
    let sentBody: any;
    const url = await serve((_req, body, res) => { sentBody = body; sse(res, f.stream("streamed text")); });
    const pieces: string[] = [];
    const result = await protocolClient(f.protocol, { baseUrl: url, apiKey: "k-secret-1" }).turn(request({ tools: [] }), { onText: (d) => pieces.push(d) });
    expect(sentBody.stream).toBe(true);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe("streamed text");
    expect(result).toMatchObject({ text: "streamed text", stop: "end", usage: { output: 6 } });
  });

  it("a streamed tool call is put together from its pieces", async () => {
    const frames = f.protocol === "v1_messages"
      ? [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_9", name: "getNode", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"id\":" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"n9\"}" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      ]
      : [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "getNode", arguments: "{\"id\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"n9\"}" } }] }, finish_reason: "tool_calls" }] },
      ];
    const url = await serve((_req, _body, res) => sse(res, frames));
    const result = await protocolClient(f.protocol, { baseUrl: url, apiKey: "k-secret-1" }).turn(request(), { onText: () => undefined });
    expect(result).toMatchObject({ stop: "tool_use", toolCalls: [{ id: "call_9", name: "getNode", input: { id: "n9" } }] });
  });

  it.each([
    [401, "credential_rejected"], [403, "credential_rejected"], [429, "rate_limited"], [404, "model_unavailable"],
    [400, "bad_request"], [402, "billing_error"], [503, "api_unavailable"], [418, "api_error"],
  ])("HTTP %i becomes the neutral code %s, and the service's own text never escapes", async (status, code) => {
    const url = await serve((_req, _body, res) => json(res, { error: { message: "SECRET-PROVIDER-TEXT" } }, status));
    const error = await protocolClient(f.protocol, { baseUrl: url, apiKey: "k-secret-1" }).turn(request()).catch((e) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe(code);
    expect(String(error.message)).not.toContain("SECRET-PROVIDER-TEXT");
  });

  it("a reply in the wrong shape is api_error; a closed port is api_unreachable; an aborted call is stopped", async () => {
    const bad = await serve((_req, _body, res) => json(res, { nothing: "useful" }));
    expect((await protocolClient(f.protocol, { baseUrl: bad, apiKey: "k-secret-1" }).turn(request()).catch((e) => e)).code).toBe("api_error");
    const notJson = await serve((_req, _body, res) => { res.end("<html>oops</html>"); });
    expect((await protocolClient(f.protocol, { baseUrl: notJson, apiKey: "k-secret-1" }).turn(request()).catch((e) => e)).code).toBe("api_error");
    expect((await protocolClient(f.protocol, { baseUrl: "http://127.0.0.1:1", apiKey: "k-secret-1" }).turn(request()).catch((e) => e)).code).toBe("api_unreachable");
    const slow = await serve(() => undefined);
    const abort = new AbortController();
    const pending = protocolClient(f.protocol, { baseUrl: slow, apiKey: "k-secret-1" }).turn(request(), { signal: abort.signal }).catch((e) => e);
    setTimeout(() => abort.abort(), 30);
    expect((await pending).code).toBe("stopped");
  });

  it("lists the models the service itself reports", async () => {
    const url = await serve((req, _body, res) => json(res, req.url?.startsWith("/v1/models") ? f.models : {}));
    const models = await protocolClient(f.protocol, { baseUrl: url, apiKey: "k-secret-1" }).listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "m1", lifecycle: "active", web_search: f.protocol === "v1_messages" });
  });

  it("a base address that already names a version is used as written", async () => {
    let path = "";
    const url = await serve((req, _body, res) => { path = req.url ?? ""; json(res, f.text("ok")); });
    await protocolClient(f.protocol, { baseUrl: `${url}/v1/`, apiKey: "k-secret-1" }).turn(request());
    expect(path).toBe(f.path);
  });
});

describe("web search is the format's own tool", () => {
  it("the /v1/messages format sends it and reports the searches it ran (length only); the chat format has none", async () => {
    let tools: any[] = [];
    const url = await serve((_req, body, res) => {
      tools = body.tools;
      json(res, { content: [{ type: "server_tool_use", name: "web_search", input: { query: "secret words" } }, { type: "text", text: "found" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const client = protocolClient("v1_messages", { baseUrl: url, apiKey: "k-secret-1" });
    expect(client.supportsWebSearch).toBe(true);
    const result = await client.turn(request({ webSearch: true }));
    expect(tools.some((t) => t.name === "web_search")).toBe(true);
    expect(result.searchQueryLengths).toEqual(["secret words".length]);
    expect(protocolClient("v1_chat_completions", { baseUrl: url, apiKey: "k-secret-1" }).supportsWebSearch).toBe(false);
  });
});

describe("a chat-format service sending broken tool arguments", () => {
  it("is flagged so the model can be told, instead of failing the session", async () => {
    const url = await serve((_req, _body, res) => json(res, {
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "getNode", arguments: "{not json" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const result = await protocolClient("v1_chat_completions", { baseUrl: url, apiKey: "k-secret-1" }).turn(request());
    expect(result.toolCalls[0]).toMatchObject({ id: "c1", badArguments: true });
  });
});

describe("detectProtocol", () => {
  it.each(FORMATS)("tells $protocol from the shape of the model list", async (f) => {
    const url = await serve((req, _body, res) => (req.url?.startsWith("/v1/models") ? json(res, f.models) : json(res, {}, 404)));
    expect(await detectProtocol({ baseUrl: url, apiKey: "k-secret-1" })).toBe(f.protocol);
  });

  it("sends the key both ways, so either kind of service answers", async () => {
    let headers: IncomingMessage["headers"] = {};
    const url = await serve((req, _body, res) => { headers = req.headers; json(res, FORMATS[1]!.models); });
    await detectProtocol({ baseUrl: url, apiKey: "k-secret-1" });
    expect(headers.authorization).toBe("Bearer k-secret-1");
    expect(headers["x-api-key"]).toBe("k-secret-1");
  });

  it("returns null when it cannot tell (an unknown shape, or no model list at all) so the person can choose", async () => {
    expect(await detectProtocol({ baseUrl: await serve((_r, _b, res) => json(res, { data: [{ name: "x" }] })), apiKey: "k-secret-1" })).toBeNull();
    expect(await detectProtocol({ baseUrl: await serve((_r, _b, res) => json(res, {}, 404)), apiKey: "k-secret-1" })).toBeNull();
    expect(await detectProtocol({ baseUrl: await serve((_r, _b, res) => { res.end("<html>"); }), apiKey: "k-secret-1" })).toBeNull();
  });

  it("says so when the key is refused or the address is unreachable, instead of calling the format unknown", async () => {
    const refused = await serve((_r, _b, res) => json(res, {}, 401));
    expect((await detectProtocol({ baseUrl: refused, apiKey: "k-secret-1" }).catch((e) => e)).code).toBe("credential_rejected");
    expect((await detectProtocol({ baseUrl: "http://127.0.0.1:1", apiKey: "k-secret-1" }).catch((e) => e)).code).toBe("api_unreachable");
  });

  it("the override variable (and its older name) redirects every key to one service", async () => {
    const url = await serve((_r, _b, res) => json(res, FORMATS[1]!.models));
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = url;
    expect(await detectProtocol({ baseUrl: "http://127.0.0.1:1", apiKey: "k-secret-1" })).toBe("v1_chat_completions");
    delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    process.env.ONDEN_ANTHROPIC_BASE_URL = url;
    try { expect(await detectProtocol({ baseUrl: "http://127.0.0.1:1", apiKey: "k-secret-1" })).toBe("v1_chat_completions"); } finally { delete process.env.ONDEN_ANTHROPIC_BASE_URL; }
  });

  it("refuses an address that is not http(s)", async () => {
    expect((await detectProtocol({ baseUrl: "file:///etc/passwd", apiKey: "k-secret-1" }).catch((e) => e)).code).toBe("bad_request");
  });
});
