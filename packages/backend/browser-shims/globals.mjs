// 每個 bundle 開頭注入：Buffer、process（config.ts 讀 process.env）、以及有 .unref() 的計時器（Node 的 Timeout 物件有，瀏覽器的是數字）。
import { Buffer as B } from "buffer";
export const Buffer = B;
export const process = {
  env: {}, cwd: () => "/", argv: [], platform: "browser", versions: {}, version: "v22.0.0",
  nextTick: (f, ...a) => queueMicrotask(() => f(...a)), on() {}, off() {}, emitWarning() {}, memoryUsage: () => ({ rss: 0 }), hrtime: () => [0, 0],
  stdout: { write() {} }, stderr: { write() {} },
};
const timer = (set, clear) => {
  const clearNative = globalThis[clear];
  return {
    set: (fn, ms, ...args) => {
      const id = globalThis[set + "Native"](fn, ms, ...args);
      return { unref() { return this; }, ref() { return this; }, hasRef: () => true, [Symbol.toPrimitive]: () => id, __id: id };
    },
    clear: (t) => clearNative(t && typeof t === "object" && "__id" in t ? t.__id : t),
  };
};
for (const [set, clear] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]]) {
  if (globalThis[set + "Native"]) continue;
  globalThis[set + "Native"] = globalThis[set].bind(globalThis);
  const t = timer(set, clear);
  globalThis[set] = t.set;
  globalThis[clear] = t.clear;
}
