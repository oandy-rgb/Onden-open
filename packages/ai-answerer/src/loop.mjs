// The loop: wait for a question, take it, run the AI tool once, hand the answer back. One question at a
// time. It never spins: every failure path sleeps first (account refused: 1 min, network or server: 15 s).
import { endpoint, ProtocolError } from "./protocol.mjs";
import { assemblePrompt } from "./prompt.mjs";

export const MAX_RUN_MS = 10 * 60_000;
/** The session key dies with the session at its deadline, so the tool is stopped a little earlier to leave time to say "failed". */
export const DEADLINE_MARGIN_MS = 5000;
const PROGRESS_FLUSH_MS = 300;
const MAX_PROGRESS_SEQ = 1900;
const OPEN = new Set(["queued", "delivered", "running"]);

/** Build a strict conversation key (space + note + agent + initiator + system) for warm session reuse.
 * @param {import("./protocol.mjs").Claim} claim @param {string} system @returns {string | undefined}
 */
function threadKeyFor(claim, system) {
  if (!claim.note?.space_id || !claim.note?.id) return undefined;
  return JSON.stringify([claim.note.space_id, claim.note.id, claim.agent?.actor_id ?? "", claim.initiator?.actor_id ?? "", system]);
}

/** @param {number} ms @param {AbortSignal} [signal] */
export const sleepUnlessStopped = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve(undefined);
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(undefined); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done);
});

/** What the loop is doing, for a caller that shows it (the desktop app): the CLI only logs. @typedef {"waiting" | "answering" | "refused" | "unreachable"} LoopState */

/**
 * @param {{
 *   client: ReturnType<typeof import("./protocol.mjs").createClient>,
 *   adapter: import("./adapters/index.mjs").Adapter,
 *   baseUrl: string,
 *   log?: (line: string) => void,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   waitSeconds?: number,
 *   cancelPollMs?: number,
 *   now?: () => number,
 *   onState?: (state: LoopState) => void,
 * }} options
 */
export async function runLoop({ client, adapter, baseUrl, log = () => {}, signal, sleep = sleepUnlessStopped, waitSeconds = 25, cancelPollMs = 3000, now = Date.now, onState = () => {} }) {
  const stopped = () => signal?.aborted === true;

  /** @param {string} id */
  async function answer(id) {
    let claim;
    try {
      claim = await client.claim(id);
    } catch (error) {
      if (error instanceof ProtocolError && error.status === 429) { log("同時進行的問題已達上限，稍後再領"); await sleep(10_000, signal); }
      else if (error instanceof ProtocolError && (error.status === 409 || error.status === 404)) log("這個問題已被別人領走或已結束，略過");
      else log(`領取失敗（${error instanceof ProtocolError ? error.code : "未知"}）`);
      return;
    }
    const { id: sessionId, deadline_at } = claim.session;
    const key = claim.mcp.token;
    const remaining = (Date.parse(deadline_at) || Infinity) - now();
    const deadline = now() + Math.min(remaining - Math.min(DEADLINE_MARGIN_MS, remaining * 0.25), MAX_RUN_MS);

    /** The one outcome a claimed question ends with. Every way out of here sends exactly one: the default is a failure,
     *  and only "the server already ended it" (cancelled, deadline passed) sends nothing. @type {Parameters<typeof client.finish>[2] | null} */
    let outcome = { status: "failed", fail_code: "agent_error" };
    const cancel = new AbortController();
    const onStop = () => cancel.abort();
    /** @type {Promise<void>} */
    let watching = Promise.resolve();
    try {
      try {
        await client.event(sessionId, key, { seq: 0, kind: "ack" });
      } catch (error) {
        log(`無法開始這個問題（${error instanceof ProtocolError ? error.code : "未知"}）`);
        if (error instanceof ProtocolError && [401, 404, 409].includes(error.status)) outcome = null; // already over
        return;
      }

      // Stop the tool when the person cancels (or the server ended the session some other way).
      watching = (async () => {
        while (!cancel.signal.aborted && !stopped()) {
          await sleep(cancelPollMs, cancel.signal);
          if (cancel.signal.aborted) return;
          try {
            const { status } = await client.status(sessionId, key, cancel.signal);
            if (!OPEN.has(status)) { cancel.abort(); return; }
          } catch (error) {
            // A dead session key (401/404) means the session is over; a network hiccup means look again.
            if (error instanceof ProtocolError && (error.status === 401 || error.status === 404)) { cancel.abort(); return; }
          }
        }
      })();
      signal?.addEventListener("abort", onStop);

      log("問題已領取，交給 AI 工具");
      onState("answering");
      const { system, prompt } = assemblePrompt(claim.rendered);
      const mcpUrl = endpoint(baseUrl, claim.mcp.path);

      // Stream tool steps and throttled text deltas back to Onden's progress log (best-effort: never fails a turn).
      let seq = 1;
      let pendingText = "";
      let progressChain = Promise.resolve();
      /** @type {ReturnType<typeof setTimeout> | null} */
      let flushTimer = null;
      const pushEvent = (/** @type {{ kind: "action" | "message", tool?: string, text?: string }} */ ev) => {
        if (cancel.signal.aborted || seq > MAX_PROGRESS_SEQ) return;
        const mySeq = seq++;
        progressChain = progressChain
          .then(() => client.event(sessionId, key, { seq: mySeq, ...ev }))
          .catch(() => {});
      };
      const flushText = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (!pendingText) return;
        const chunk = pendingText;
        pendingText = "";
        pushEvent({ kind: "message", text: chunk });
      };
      /** @param {{ kind: "action" | "message", tool?: string, text?: string }} ev */
      const onProgress = (ev) => {
        if (ev.kind === "action" && ev.tool) {
          flushText();
          pushEvent({ kind: "action", tool: ev.tool });
        } else if (ev.kind === "message" && ev.text) {
          pendingText += ev.text;
          if (!flushTimer) flushTimer = setTimeout(flushText, PROGRESS_FLUSH_MS);
        }
      };

      let result;
      try {
        result = await adapter.run({
          system,
          prompt,
          mcpUrl,
          sessionKey: key,
          deadline,
          signal: cancel.signal,
          threadKey: threadKeyFor(claim, system),
          messages: claim.rendered.messages,
          onProgress,
        });
      } finally {
        flushText();
        await progressChain;
      }
      if (result.ok) outcome = { status: "completed", result_markdown: result.text };
      else if (result.reason === "cancelled") {
        // Stopped because the person cancelled (the server has already ended it) or because this program is shutting down (it has not).
        outcome = stopped() ? { status: "failed", fail_code: "stopped" } : null;
        log(stopped() ? "程式結束，這個問題標成失敗" : "問題已取消，已停止 AI 工具");
      } else log(`沒有答案（${result.reason}）`);
    } catch (error) {
      log(`處理問題時出錯（${error instanceof Error ? error.name : "未知"}）`);
    } finally {
      cancel.abort();
      signal?.removeEventListener("abort", onStop);
      await watching;
      onState("waiting");
      if (outcome) await settle(sessionId, key, outcome);
    }
  }

  /** Send the outcome. An answer the server refuses as such (too long, empty) is sent as a failure instead, so the question never waits for its deadline.
   *  @param {string} sessionId @param {string} key @param {NonNullable<Parameters<typeof client.finish>[2]>} outcome */
  async function settle(sessionId, key, outcome) {
    try {
      await client.finish(sessionId, key, outcome);
      if (outcome.status === "completed") log("已回答");
    } catch (error) {
      const refused = error instanceof ProtocolError && error.status >= 400 && error.status < 500 && ![401, 404, 409].includes(error.status);
      if (outcome.status === "completed" && refused) {
        log(`答案被伺服器拒絕（${error.code}），改回報失敗`);
        await settle(sessionId, key, { status: "failed", fail_code: error.code === "reply_too_long" ? "reply_too_long" : "reply_rejected" });
        return;
      }
      log(`交回結果失敗（${error instanceof ProtocolError ? error.code : "未知"}）；問題會在期限後標成失敗`);
    }
  }

  try {
    while (!stopped()) {
      const started = now();
      let ids;
      try {
        onState("waiting");
        ids = await client.pending(waitSeconds, signal);
      } catch (error) {
        if (stopped()) break;
        if (error instanceof ProtocolError && (error.status === 401 || error.status === 403)) {
          onState("refused"); log("連線碼被拒絕（可能已撤銷或換過）；一分鐘後再試"); await sleep(60_000, signal);
        } else {
          onState("unreachable"); log("連不上伺服器；15 秒後再試"); await sleep(15_000, signal);
        }
        continue;
      }
      for (const id of ids) { if (stopped()) break; await answer(id); }
      // A server that answers "nothing" at once (module off) must not become a tight loop.
      if (ids.length === 0 && now() - started < 1000) await sleep(2000, signal);
    }
  } finally {
    await adapter.dispose?.();
  }
}
