// 實驗：用 PGlite 假裝成 `pg`（後端 db.ts 與 better-auth/kysely 只用到 Pool.query / connect / release / on / end）。
// 重點是「單一連線」：Pool.connect() 取得整條連線，直到 release() 才讓下一個人進來（FIFO 互斥鎖），
// 所以兩個同時開交易的請求會排隊，不會互相穿插。
import { PGlite, types } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

let dbPromise;
export function pgliteInstance() {
  dbPromise ??= (async () => {
    const dataDir = globalThis.__ONDEN_PGLITE_DIR ?? "memory://";
    const db = new PGlite(dataDir, {
      extensions: { vector, pgcrypto, pg_trgm },
      // 持久化（idb:// 與 opfs-ahp://）預設每次查詢都同步寫回；relaxedDurability 讓寫回延後（崩潰時可能丟掉最後幾筆），實測差一個數量級
      ...(globalThis.__ONDEN_RELAXED === "1" ? { relaxedDurability: true } : {}),
      // 與 `pg` 一致：bigint / numeric 以字串回傳（後端的 parseBigintId、事件游標都假設是字串）
      parsers: { [types.INT8]: (v) => v, [types.NUMERIC]: (v) => v },
    });
    await db.waitReady;
    return db;
  })();
  return dbPromise;
}

class Mutex {
  #tail = Promise.resolve();
  waiting = 0;
  async acquire() {
    let release;
    const next = new Promise((r) => (release = r));
    const prev = this.#tail;
    this.#tail = prev.then(() => next);
    this.waiting++;
    await prev;
    this.waiting--;
    return release;
  }
}

const mutex = new Mutex();
let holder = null;
export const stats = { queries: 0, maxQueueDepth: 0, lockWaitMs: 0 };

async function run(text, params) {
  const db = await pgliteInstance();
  stats.queries++;
  const r = await db.query(text, params);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, command: r.command, fields: r.fields };
}

class Client {
  constructor(release) { this._release = release; }
  query(text, params) { return run(typeof text === "string" ? text : text.text, params ?? (typeof text === "object" ? text.values : undefined)); }
  release() { const r = this._release; this._release = null; r?.(); }
}

class Pool {
  #listeners = {};
  totalCount = 1; idleCount = 0; waitingCount = 0;
  on(ev, fn) { (this.#listeners[ev] ??= []).push(fn); return this; }
  async connect(label = "connect") {
    const t0 = performance.now();
    // 死結偵測（實驗用）：等超過 1.5 秒就印出「誰在等」與「誰握著連線」
    const myStack = new Error(label).stack;
    const timer = setTimeout(() => {
      console.error("[pgShim] 連線等待超過 1.5 秒 → 疑似死結\n--- 等待者 ---\n" + myStack?.split("\n").slice(1, 9).join("\n") + "\n--- 握著連線者 ---\n" + (holder?.split("\n").slice(1, 12).join("\n") ?? "?"));
    }, 1500);
    stats.maxQueueDepth = Math.max(stats.maxQueueDepth, mutex.waiting + 1);
    const release = await mutex.acquire();
    clearTimeout(timer);
    holder = myStack;
    stats.lockWaitMs += performance.now() - t0;
    return new Client(release);
  }
  async query(text, params) {
    // 單一連線的關鍵：後端有 162 處直接 pool.query，其中一部分（例如 putBlob）發生在別人開著的交易「裡面」。
    // 真 Postgres 會走另一條連線；單連線若也排隊就是死結。所以「已在交易裡」就沿用該交易的連線。
    // 取得 db.ts 的交易上下文需要一行修補（esbuild-plugins.mjs 的 exposeTxStorage）。
    const ambient = globalThis.__ondenTxStorage?.getStore();
    if (ambient) return ambient.query(text, params);
    const c = await this.connect("pool.query: " + String(text).slice(0, 80));
    try { return await c.query(text, params); } finally { c.release(); }
  }
  async end() { const db = await pgliteInstance(); await db.close(); }
}

export default { Pool, types: { builtins: {}, setTypeParser() {} } };
export { Pool };
