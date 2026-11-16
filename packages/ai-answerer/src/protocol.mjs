// The pull protocol of docs/self-host/ai-client-on-a-machine.md as one small client.
// Two credentials, never interchangeable (routes/mcpSessions.ts):
//   connection code (the AI's own)  pending, claim
//   session key (minted by claim)   events, finish, status of that session
// Pure: it takes `fetch`, touches no file and logs nothing, so the loop and the tests share it.

/** A reply that was not 2xx. `status` 0 means the network failed before any reply. */
export class ProtocolError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(`${status} ${code}`);
    this.name = "ProtocolError";
    this.status = status;
    this.code = code;
  }
}

/** An address on the server: the base may carry a path (https://host/onden), so it is joined, not resolved. @param {string} baseUrl @param {string} path */
export const endpoint = (baseUrl, path) => `${baseUrl.replace(/\/+$/, "")}${path}`;

/** @typedef {{ system: string, messages: Array<{ role: string, content: string }> }} Rendered */
/** @typedef {{ session: { id: string, deadline_at: string }, rendered: Rendered, mcp: { path: string, token: string } }} Claim */

/**
 * @param {{ baseUrl: string, connectionCode: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<unknown> }} options
 */
export function createClient({ baseUrl, connectionCode, fetch: doFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  
  /** @param {string} path @param {string} bearer @param {{ method?: string, json?: unknown, signal?: AbortSignal }} [init] */
  async function call(path, bearer, init = {}) {
    let response;
    try {
      response = await doFetch(endpoint(baseUrl, path), {
        method: init.method ?? (init.json === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${bearer}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }) },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: init.signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ProtocolError(0, "network");
    }
    const text = await response.text();
    /** @type {any} */
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON: the status still tells */ }
    if (!response.ok) throw new ProtocolError(response.status, typeof body?.error === "string" ? body.error : "http_error");
    return body;
  }

  return {
    /** Long poll: the ids of queued sessions, or [] after `wait` seconds. @param {number} wait @param {AbortSignal} [signal] */
    async pending(wait, signal) {
      const body = await call(`/api/mcp/sessions/pending?wait=${wait}`, connectionCode, { signal });
      return /** @type {string[]} */ ((body?.sessions ?? []).map((/** @type {{ id: string }} */ s) => s.id));
    },
    /** Take one. 409 = someone else holds it or it is closed. @param {string} id @returns {Promise<Claim>} */
    claim: (id) => call(`/api/mcp/sessions/${encodeURIComponent(id)}/claim`, connectionCode, { method: "POST", json: {} }),
    /** @param {string} id @param {string} sessionKey @param {{ seq: number, kind: "ack" | "thought" | "action", text?: string, tool?: string }} event */
    event: (id, sessionKey, event) => call(`/api/mcp/sessions/${encodeURIComponent(id)}/events`, sessionKey, { json: event }),
    /** @param {string} id @param {string} sessionKey @param {AbortSignal} [signal] @returns {Promise<{ status: string }>} */
    status: (id, sessionKey, signal) => call(`/api/mcp/sessions/${encodeURIComponent(id)}`, sessionKey, { signal }),
    /**
     * Hand the result back; retried up to 3 times on network failure or 5xx.
     * Sending the same result again is harmless (the server answers `replayed`).
     * @param {string} id @param {string} sessionKey
     * @param {{ status: "completed", result_markdown: string } | { status: "failed", fail_code?: string }} result
     */
    async finish(id, sessionKey, result) {
      let last;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await call(`/api/mcp/sessions/${encodeURIComponent(id)}/finish`, sessionKey, { json: result });
        } catch (error) {
          last = error;
          const retryable = error instanceof ProtocolError && (error.status === 0 || error.status >= 500);
          if (!retryable || attempt === 3) break;
          await sleep(1000 * attempt);
        }
      }
      throw last;
    },
  };
}
