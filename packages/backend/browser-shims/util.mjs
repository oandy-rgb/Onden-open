// node:util：isDeepStrictEqual 用結構比較（鍵順序無關、遞迴比 Array／Date／plain object）。
export function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && isDeepStrictEqual(a[k], b[k]));
}
export const promisify = (f) => (...a) => new Promise((res, rej) => f(...a, (e, v) => (e ? rej(e) : res(v))));
export const inspect = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
export const types = {};
export default { isDeepStrictEqual, promisify, inspect, types };
