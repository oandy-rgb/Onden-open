// node:async_hooks 的瀏覽器替身：AsyncLocalStorage 用 zone.js 實作（只支援後端用到的 run / getStore）。
// zone.js 會取代全域 Promise；原生 async/await 不經過它，所以後端必須用 target=es2016 打包，讓 esbuild 把 async/await 降級成 Promise 鏈。
import "zone.js";
export class AsyncLocalStorage {
  #key = Symbol("als");
  run(store, fn, ...args) {
    return Zone.current.fork({ name: "als", properties: { [this.#key]: { store } } }).run(fn, undefined, args);
  }
  getStore() { return Zone.current.get(this.#key)?.store; }
}
export default { AsyncLocalStorage };
