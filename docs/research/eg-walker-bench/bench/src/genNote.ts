// 依 Onden 筆記形狀合成 Markdown：標題、段落（一段一行、多句）、清單、任務清單、表格、
// 程式碼區塊、中英混排、emoji（含非 BMP）。固定種子可重現；Node 與瀏覽器產生完全相同的文字。
import type { Rng } from "./prng.js";

const ZH = ["筆記", "同步", "合併", "衝突", "段落", "標題", "版本", "歷史", "手機", "伺服器", "編輯器", "游標", "離線", "標籤", "連結", "白板", "任務", "日記", "搜尋", "備份", "權限", "復原", "草稿", "章節", "摘要", "研究", "實驗", "資料庫", "效能", "記憶體", "使用者", "工作區", "快取", "字元", "文件", "指令", "清單", "表格", "圖片", "日期"];
const VERB = ["整理", "檢查", "更新", "移動", "刪除", "新增", "比較", "重放", "保存", "載入", "排序", "分享", "匯出", "匯入", "追蹤", "標記", "確認", "測量", "改寫", "合併"];
const EN = ["CodeMirror", "Markdown", "TypeScript", "WebAssembly", "Postgres", "offline-first", "CRDT", "diff3", "merge", "commit", "branch", "latency", "benchmark", "token", "workspace", "snapshot", "cursor", "range", "viewport", "payload"];
const EMOJI = ["😀", "🚀", "📌", "✅", "🔥", "📚", "🧪", "💡", "🎯", "🐛"];
const ADJ = ["重要的", "簡單的", "穩定的", "最新的", "尚未完成的", "每日的", "共用的", "暫時的", "有趣的", "必要的"];

export function genSentence(rng: Rng): string {
  const parts: string[] = [];
  const n = 3 + rng.int(5);
  for (let i = 0; i < n; i++) {
    const r = rng.next();
    if (r < 0.45) parts.push(rng.pick(ZH));
    else if (r < 0.62) parts.push(" " + rng.pick(EN) + " ");
    else if (r < 0.80) parts.push(rng.pick(VERB));
    else if (r < 0.9) parts.push(rng.pick(ADJ));
    else parts.push("的");
  }
  if (rng.chance(0.08)) parts.push(rng.pick(EMOJI));
  const end = rng.chance(0.75) ? "。" : rng.chance(0.5) ? "！" : rng.chance(0.5) ? "？" : ". ";
  return parts.join("").replace(/ {2,}/g, " ").trim() + end;
}

const phrase = (rng: Rng): string => {
  const w = [rng.pick(ZH), rng.chance(0.3) ? ` ${rng.pick(EN)} ` : rng.pick(VERB), rng.chance(0.15) ? rng.pick(EMOJI) : rng.pick(ZH)];
  return w.join("");
};
export { phrase as genPhrase };

function paragraph(rng: Rng): string {
  const n = 2 + rng.int(5);
  const s: string[] = [];
  for (let i = 0; i < n; i++) s.push(genSentence(rng));
  return s.join("") + "\n\n";
}

function list(rng: Rng, task: boolean): string {
  const n = 3 + rng.int(6);
  let out = "";
  for (let i = 0; i < n; i++) out += `- ${task ? (rng.chance(0.4) ? "[x] " : "[ ] ") : ""}${genSentence(rng)}\n`;
  return out + "\n";
}

function table(rng: Rng): string {
  const rows = 3 + rng.int(6);
  let out = `| ${rng.pick(ZH)} | ${rng.pick(EN)} | ${rng.pick(ZH)} |\n| --- | --- | --- |\n`;
  for (let i = 0; i < rows; i++) out += `| ${rng.pick(ZH)}${rng.pick(VERB)} | ${rng.pick(EN)} | ${rng.int(1000)} ms |\n`;
  return out + "\n";
}

function code(rng: Rng): string {
  return "```ts\n" + `const ${rng.pick(EN).replace(/\W/g, "_")} = ${rng.int(100)};\nfunction f${rng.int(99)}(x: number) { return x + ${rng.int(9)}; }\n` + "```\n\n";
}

/** 產生至少 targetBytes（UTF-8）的筆記。 */
export function genNote(targetBytes: number, rng: Rng): string {
  const enc = new TextEncoder();
  let out = `# ${rng.pick(ZH)}${rng.pick(ZH)}筆記 ${rng.pick(EMOJI)}\n\n`;
  let bytes = enc.encode(out).length;
  let sec = 0;
  while (bytes < targetBytes) {
    let block: string;
    const r = rng.next();
    if (sec % 9 === 0 && r < 0.6) { block = `## 第 ${++sec} 節 ${rng.pick(ZH)}${rng.pick(VERB)}\n\n`; }
    else if (r < 0.50) block = paragraph(rng);
    else if (r < 0.64) block = list(rng, false);
    else if (r < 0.72) block = list(rng, true);
    else if (r < 0.80) block = table(rng);
    else if (r < 0.84) block = code(rng);
    else if (r < 0.90) block = `### ${rng.pick(ZH)} ${rng.pick(EN)}\n\n`;
    else block = paragraph(rng);
    sec++;
    out += block;
    bytes += enc.encode(block).length;
  }
  return out;
}
