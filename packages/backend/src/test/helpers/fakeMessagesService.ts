// A fake "/v1/messages" service for the api-runtime tests: nothing here reaches the real API.
// Replies come from a script (one function per request); every request is recorded.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRequest = { path: string; body: any };
export type Reply = Record<string, unknown>;

export const usage = (input = 10, output = 5) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

export function textMessage(text: string, stopReason = "end_turn", u = usage()): Reply {
  return { id: "msg_fake", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text }], stop_reason: stopReason, stop_sequence: null, usage: u };
}
export function toolUseMessage(name: string, input: Record<string, unknown>, id = `toolu_${Math.random().toString(16).slice(2, 10)}`): Reply {
  return { id: "msg_fake", type: "message", role: "assistant", model: "test-model", content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", stop_sequence: null, usage: usage() };
}

export function modelInfo(id: string, lifecycle: "active" | "deprecated" | "retired" = "active") {
  return { id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z", deprecated_at: null, lifecycle, capabilities: null };
}

export async function startFakeMessagesService() {
  const requests: FakeRequest[] = [];
  const state = {
    script: [] as Array<(body: any) => Reply | Promise<Reply>>,
    fallback: null as null | ((body: any) => Reply | Promise<Reply>),
    models: [modelInfo("test-model")] as unknown[],
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = (req.url ?? "").split("?")[0]!;
      if (req.method === "GET" && url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: state.models, has_more: false, first_id: null, last_id: null }));
        return;
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      requests.push({ path: url, body });
      const reply = await (state.script.shift() ?? state.fallback)?.(body);
      if (!reply) { res.statusCode = 500; res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no scripted reply" } })); return; }
      if (body.stream) {
        res.setHeader("content-type", "text/event-stream");
        const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
        const blocks = reply.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        send("message_start", { message: { ...reply, content: [], stop_reason: null, usage: usage(5, 1) } });
        blocks.forEach((block, index) => {
          if (block.type === "tool_use") {
            send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
            send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
          } else {
            send("content_block_start", { index, content_block: { type: "text", text: "" } });
            for (const part of (block.text ?? "").match(/.{1,4}/gs) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: part } });
          }
          send("content_block_stop", { index });
        });
        send("message_delta", { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: (reply.usage as { output_tokens: number }).output_tokens } });
        send("message_stop", {});
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
