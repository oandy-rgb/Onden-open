// git-makefile：參考實作與原型是否輸出同一份文字（與 trace 內建預期不同，見報告）。約 2 分鐘。
import { loadTrace } from "./traces.js";
import { buildOpLog, replay } from "./proto/engine.js";
import { buildRefLog, ref } from "./refAdapter.js";
const tr = loadTrace("git-makefile");
const mine = replay(buildOpLog(tr.history));
const t0 = performance.now();
const theirs = ref.checkoutSimpleString(buildRefLog(tr.history));
const ms = performance.now() - t0;
let i = 0; while (i < mine.length && mine[i] === tr.history.endContent![i]) i++;
console.log(JSON.stringify({ refMs: Math.round(ms), refEqualsProto: mine === theirs, protoEqualsExpected: mine === tr.history.endContent, lenMine: mine.length, lenExpected: tr.history.endContent!.length, firstDiffAt: i }));
