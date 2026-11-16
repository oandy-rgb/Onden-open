// 開、關、狀態：兩個對象（A 這個桌面版自己的筆記、B 另一台伺服器）各一條回答迴圈，跑在主程序裡。
// 迴圈、協定與 AI 工具的安全旗標都是 packages/ai-answerer 的，這裡只管「要不要跑、連到哪、碼從哪來」。
// 碼只在這裡的記憶體與加密的儲存之間走，不回給網頁、不寫記錄。

/** @typedef {import("./store.mjs").TargetKey} TargetKey */
/** @typedef {"stopped" | "waiting" | "answering" | "refused" | "unreachable"} Phase */
/** @typedef {{ enabled: boolean, phase: Phase, actorId?: string, codeId?: string, address?: string }} TargetStatus */

/**
 * @param {{
 *   store: ReturnType<typeof import("./store.mjs").createAiAnsweringStore>,
 *   answerer: typeof import("../../../ai-answerer/src/index.mjs"),
 *   ownBaseUrl: () => string | null,
 *   toolCommand?: string,
 *   log?: (line: string) => void,
 * }} options
 */
export function createAiAnsweringController({ store, answerer, ownBaseUrl, toolCommand, log = () => {} }) {
  /** @type {Record<TargetKey, { abort: AbortController, done: Promise<void> } | null>} */
  const running = { own: null, remote: null };
  /** @type {Record<TargetKey, Phase>} */
  const phase = { own: "stopped", remote: "stopped" };
  const listeners = new Set(/** @type {Array<(s: ReturnType<typeof status>) => void>} */ ([]));
  const adapter = () => answerer.createAdapters({ command: toolCommand })[0];

  function status() {
    const own = store.get("own"), remote = store.get("remote");
    return /** @type {{ own: TargetStatus, remote: TargetStatus, canStoreSecurely: boolean }} */ ({
      own: { enabled: own.enabled, phase: phase.own, actorId: own.actorId, codeId: own.enabled ? own.codeId : undefined },
      remote: { enabled: remote.enabled, phase: phase.remote, address: remote.enabled ? remote.address : undefined },
      canStoreSecurely: store.available(),
    });
  }
  const notify = () => { const s = status(); for (const listener of listeners) listener(s); };
  /** @param {TargetKey} key @param {Phase} next */
  const setPhase = (key, next) => { if (phase[key] !== next) { phase[key] = next; notify(); } };

  /** @param {TargetKey} key @param {string} baseUrl @param {string} code */
  function start(key, baseUrl, code) {
    const abort = new AbortController();
    const done = answerer.runLoop({
      client: answerer.createClient({ baseUrl, connectionCode: code }), adapter: adapter(), baseUrl, signal: abort.signal,
      onState: (state) => { if (!abort.signal.aborted) setPhase(key, state); },
      log: (line) => log(`${key}: ${line}`),
    }).catch((error) => log(`${key}: 回答迴圈結束了（${error instanceof Error ? error.name : "unknown"}）`))
      .finally(() => { if (running[key]?.abort === abort) running[key] = null; setPhase(key, "stopped"); });
    running[key] = { abort, done };
    setPhase(key, "waiting");
  }
  /** @param {TargetKey} key */
  async function stop(key) {
    const current = running[key];
    if (!current) return;
    current.abort.abort();
    await current.done;
  }

  /** 開與關一次只做一件：兩個同時進來的 enable 不會各自存碼、各開一條迴圈。 */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const serial = (job) => { const next = queue.then(job, job); queue = next.then(() => {}, () => {}); return next; };

  /** @param {TargetKey} key @param {{ code: string, actorId?: string, codeId?: string, address?: string }} input */
  async function enableNow(key, { code, actorId, codeId, address }) {
    if (!store.available()) return { ok: false, reason: "no_secure_storage" };
    const tool = await adapter().detect();
    if (!tool.ok) return { ok: false, reason: tool.reason };
    let baseUrl;
    if (key === "own") {
      baseUrl = ownBaseUrl();
      if (!baseUrl) return { ok: false, reason: "not_ready" };
    } else {
      const parsed = answerer.parseServerAddress(address ?? "");
      if (!parsed.ok) return { ok: false, reason: "bad_address" };
      baseUrl = parsed.baseUrl;
      // 存之前用這把碼問一次「有沒有問題」：碼不對或連不上，現在就說。
      try { await answerer.createClient({ baseUrl, connectionCode: code }).pending(0); }
      catch (error) {
        const status = /** @type {{ status?: number }} */ (error).status;
        return { ok: false, reason: status === 401 || status === 403 ? "code_refused" : "unreachable" };
      }
    }
    await stop(key);
    store.saveEnabled(key, { code, actorId, codeId, address: key === "remote" ? baseUrl : undefined });
    start(key, baseUrl, code);
    notify();
    return { ok: true };
  }

  /** @param {TargetKey} key */
  async function disableNow(key) {
    await stop(key);
    store.forgetCode(key);
    notify();
    return { ok: true };
  }

  return {
    status,
    /** @param {(s: ReturnType<typeof status>) => void} listener */
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    /** 這台電腦上的 AI 工具能不能用。 */
    async detect() {
      const result = await adapter().detect();
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },

    /** 打開一個對象：先確認工具與安全儲存，存下碼，開始回答。回 { ok: true } 或 { ok: false, reason }。同時只做一件。 @param {TargetKey} key @param {{ code: string, actorId?: string, codeId?: string, address?: string }} input */
    enable: (key, input) => serial(() => enableNow(key, input)),

    /** 關掉：停止回答（進行中的 AI 工具被停掉）、忘掉碼。伺服器上的連線碼由網頁用既有操作作廢。 @param {TargetKey} key */
    disable: (key) => serial(() => disableNow(key)),

    /** App 啟動、後端就緒後：把關前開著的對象接回來。 */
    restore() {
      for (const key of /** @type {TargetKey[]} */ (["own", "remote"])) {
        const saved = store.get(key);
        if (!saved.enabled || !saved.code || running[key]) continue;
        const baseUrl = key === "own" ? ownBaseUrl() : saved.address ?? null;
        if (baseUrl) start(key, baseUrl, saved.code);
      }
    },

    /** App 結束：停掉所有迴圈與 AI 工具（暫存資料夾由轉接層在結束時刪掉）。 */
    async stopAll() {
      await Promise.all(/** @type {TargetKey[]} */ (["own", "remote"]).map((key) => stop(key)));
    },
  };
}

/** 回答程式載入失敗時用的替身：按鈕說「這個版本現在不能用」，App 其他部分照常。 */
export function unavailableAiAnswering() {
  const off = { enabled: false, phase: /** @type {Phase} */ ("stopped") };
  return {
    status: () => ({ own: off, remote: off, canStoreSecurely: false }),
    subscribe: () => () => {},
    detect: async () => ({ ok: false, reason: "unavailable" }),
    enable: async () => ({ ok: false, reason: "unavailable" }),
    disable: async () => ({ ok: true }),
    restore() {},
    async stopAll() {},
  };
}
