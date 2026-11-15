// node:async_hooks：better-auth 等套件用的 AsyncLocalStorage。與 requestContext.ts 的串行堆疊同一個語意（宿主一次只跑一個流程）。
export class AsyncLocalStorage {
  #stack = [];
  run(store, fn, ...args) {
    this.#stack.push(store);
    const pop = () => { const at = this.#stack.lastIndexOf(store); if (at >= 0) this.#stack.splice(at, 1); };
    let result;
    try { result = fn(...args); } catch (e) { pop(); throw e; }
    if (result && typeof result.then === "function") return result.finally(pop);
    pop();
    return result;
  }
  getStore() { return this.#stack[this.#stack.length - 1]; }
}
export default { AsyncLocalStorage };
