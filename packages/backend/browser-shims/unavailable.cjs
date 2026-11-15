// 瀏覽器版不提供的套件／內建模組：載入時不報錯；建構或 await 呼叫的結果才說「瀏覽器版沒有這個」。
// 有些套件在 import 時就會呼叫（Octokit.plugin(...)），所以呼叫本身不丟錯，結果被使用（await、new）才丟。
const make = (name, late) => {
  const fail = () => new Error(`${name} is not available in the browser app`);
  return new Proxy(function () {}, {
    get: (_, k) => (k === "__esModule" ? false : k === "then" ? (late ? (_resolve, reject) => reject(fail()) : undefined) : k === "prototype" ? {} : make(`${name}.${String(k)}`, late)),
    apply: () => make(`${name}()`, true),
    construct: () => { throw fail(); },
  });
};
module.exports = make("unavailable", false);
