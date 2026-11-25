// Ephemeral loopback-only MCP auth proxy for warm ACP sessions.
//
// Why this exists:
//   Onden mints a fresh single-session MCP Bearer token on every `claim`, while a warm ACP
//   subprocess (`agy acp`, `copilot --acp`) binds its MCP server URL once at `session/new`.
//   Pointing `session/new` at this local 127.0.0.1 random-port + 128-bit secret-path proxy lets
//   a warm session reuse its MCP connection across turns of the same conversation while the proxy
//   swaps in each turn's fresh `Authorization: Bearer <sessionKey>` in memory and clears it the
//   instant the turn ends (returning 401 while idle). The key never touches argv, env, or disk.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "authorization",
]);

/**
 * Start a loopback MCP auth proxy on an ephemeral port.
 * @param {{ fetch?: typeof fetch }} [options]
 */
export async function createMcpAuthProxy({ fetch: doFetch = fetch } = {}) {
  const secretPath = `/mcp-${randomBytes(16).toString("hex")}`;
  /** @type {{ targetUrl: string, sessionKey: string } | null} */
  let active = null;
  /** @type {Set<AbortController>} */
  const inFlight = new Set();

  const server = createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== secretPath) {
      res.writeHead(404);
      res.end();
      return;
    }
    const target = active;
    if (!target) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_active_session" }));
      return;
    }
    const method = req.method ?? "POST";
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    req.on("end", async () => {
      const controller = new AbortController();
      inFlight.add(controller);
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      try {
        /** @type {Record<string, string>} */
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const low = k.toLowerCase();
          if (HOP_BY_HOP.has(low) || v === undefined) continue;
          headers[low] = Array.isArray(v) ? v.join(", ") : v;
        }
        headers.authorization = `Bearer ${target.sessionKey}`;
        const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
        const upstream = await doFetch(target.targetUrl, { method, headers, body, signal: controller.signal });
        /** @type {Record<string, string>} */
        const outHeaders = {};
        upstream.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
        });
        res.writeHead(upstream.status, outHeaders);
        if (!upstream.body) { res.end(); return; }
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.destroyed) res.write(Buffer.from(value));
        }
        if (!res.writableEnded) res.end();
      } catch {
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end();
      } finally {
        inFlight.delete(controller);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}${secretPath}`;

  return {
    url,
    /** Activate forwarding for one claimed turn. @param {string} targetUrl @param {string} sessionKey */
    setTarget(targetUrl, sessionKey) {
      active = { targetUrl, sessionKey };
    },
    /** Clear the active turn's credentials and abort any stray in-flight requests. */
    clearTarget() {
      active = null;
      for (const c of inFlight) c.abort();
      inFlight.clear();
    },
    /** Shut down the proxy server completely. */
    async close() {
      active = null;
      for (const c of inFlight) c.abort();
      inFlight.clear();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
