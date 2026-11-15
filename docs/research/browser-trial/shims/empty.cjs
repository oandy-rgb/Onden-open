// 試用版不提供的套件／內建模組：載入時不報錯，被呼叫時才說「試用版沒有這個」。
const make = (name) => new Proxy(function () {}, {
  get: (_, k) => (k === "__esModule" ? false : k === "then" ? undefined : k === "prototype" ? {} : make(`${name}.${String(k)}`)),
  apply: () => { throw new Error(`${name} is not available in the browser trial`); },
  construct: () => { throw new Error(`${name} is not available in the browser trial`); },
});
module.exports = make("unavailable");
