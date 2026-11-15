// 掃模糊找回門檻：find（找回要多像）與 keep（差異搬過去後要多像才算數）。輸出每組的指錯／找不到次數。
import { classify } from "./lib.ts";
import { runHistory } from "./run-history.ts";
import { runSynthetic } from "./run-synthetic.ts";
import { wrongOf } from "./summarize.ts";

const combos: Array<[number, number]> = [[0.5, 0.5], [0.6, 0.5], [0.7, 0.5], [0.8, 0.5], [0.9, 0.5], [0.95, 0.5], [0.8, 0.3], [0.8, 0.7], [0.8, 0.9]];
console.log("| find | keep | M2 歷史 指對／指錯／找不到 | M3 歷史 指對／指錯／找不到 | M2 合成 指錯 | M3 合成 指錯 | M2 合成 找不到 | M3 合成 找不到 |\n|---|---|---|---|---|---|---|---|");
for (const [find, keep] of combos) {
  const recs = runHistory({ find, keep });
  const t = (m: "M2" | "M3") => { const c = { correct: 0, wrong: 0, lost: 0 }; for (const r of recs) { const k = classify(r.res[m], r.oracle); c[k === "correct" ? "correct" : k === "lost" ? "lost" : "wrong"]++; } return `${c.correct}／${c.wrong}／${c.lost}`; };
  const syn = runSynthetic({ find, keep });
  const sc = (m: "M2" | "M3", w: boolean) => syn.filter((r) => (w ? r.cls[m].startsWith("wrong") : r.cls[m] === "lost")).length;
  console.log(`| ${find} | ${keep} | ${t("M2")} | ${t("M3")} | ${sc("M2", true)} | ${sc("M3", true)} | ${sc("M2", false)} | ${sc("M3", false)} |`);
}
