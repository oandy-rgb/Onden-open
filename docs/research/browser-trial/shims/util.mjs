export function isDeepStrictEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); } // 實驗用的近似；正式版要換成真正的深比較
export const promisify = (f) => (...a) => new Promise((res, rej) => f(...a, (e, v) => (e ? rej(e) : res(v))));
export const inspect = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
export const types = {};
export class TextEncoder_ extends TextEncoder {}
export default { isDeepStrictEqual, promisify, inspect, types };
