// 驗收卡：每張 PR 說明最上面的五欄，業主只讀這一段（業主 2026-11-20 採用，取自 Tolaria 的 Ready for QA）。
// 檢查在 scripts/public-mirror/public-push.sh：每張 PR 都要推公開庫跑檢查，推之前讀 PR 說明，缺卡就不推。
// 測試：packages/markdown/src/test/guards/prCard.guard.test.ts。
//
//   ## 驗收卡
//   **改了什麼**：一兩句，給使用者看的話
//   **怎麼試**：2–4 步
//   **證據**：修 bug 是「修前失敗、修後通過」的輸出；改畫面是改前改後的截圖或錄影；改 CI 是綠的那一輪
//   **測了什麼**：一行
//   **沒測到什麼**：沒測到的（例如沒有真機）；全都測到就寫「無」
//
// 動到觸控、鍵盤、手寫這些「瀏覽器模擬不準」的檔案時，「證據」或「沒測到什麼」要提到「實機」：
// 有實機就寫在證據裡，沒有就寫在沒測到什麼裡，讓業主用自己的裝置驗（2026-11-20：平板游標被工具列蓋住，修正當初只在手機上驗過）。

export const CARD_HEADING = "## 驗收卡";
export const CARD_FIELDS = ["改了什麼", "怎麼試", "證據", "測了什麼", "沒測到什麼"];
/** 開始要求驗收卡的日子：之前開的 PR 不回頭補。 */
export const CARD_REQUIRED_FROM = "2026-11-21";

/** 瀏覽器模擬量不準、要實機證據的程式：觸控、螢幕鍵盤、手寫、行動版外殼。 */
export const DEVICE_PATHS = [
  /^packages\/frontend\/src\/lib\/editor(Keyboard|Touch|EndRoom)\b/,
  /^packages\/frontend\/src\/hooks\/use(Editor|Virtual)Keyboard\b/,
  /^packages\/frontend\/src\/lib\/touchHold\b/,
  /^packages\/frontend\/src\/lib\/ink\//,
  /^packages\/frontend\/src\/appShell\/head\.ts$/,
  /^packages\/frontend\/src\/components\/Mobile/,
];

/** PR 說明裡的驗收卡 → { 欄位: 內容 }；沒有卡回 null。內容是欄位標籤之後到下一個欄位或下一個標題之前的文字。 */
export function readCard(body) {
  const text = (body ?? "").replace(/\r/g, "");
  const start = text.indexOf(CARD_HEADING);
  if (start < 0) return null;
  const rest = text.slice(start + CARD_HEADING.length);
  const end = rest.search(/^#{1,2} /m);
  const card = end < 0 ? rest : rest.slice(0, end);
  const fields = {};
  const label = new RegExp(`\\*\\*(${CARD_FIELDS.join("|")})\\*\\*[：:]?`, "g");
  const marks = [...card.matchAll(label)];
  marks.forEach((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : card.length;
    fields[m[1]] = card.slice(from, to).replace(/<!--[\s\S]*?-->/g, "").trim();
  });
  return fields;
}

/** 驗收卡缺了什麼（空陣列＝可以推）。changedPaths：這個分支相對 main 改到的檔。 */
export function cardProblems(body, changedPaths = []) {
  const card = readCard(body);
  if (!card) return [`PR 說明沒有「${CARD_HEADING}」`];
  const problems = CARD_FIELDS.filter((f) => !card[f]).map((f) => `驗收卡的「${f}」是空的`);
  const device = changedPaths.filter((p) => DEVICE_PATHS.some((re) => re.test(p)));
  if (device.length > 0 && !/實機/.test(`${card["證據"] ?? ""}${card["沒測到什麼"] ?? ""}`)) {
    problems.push(`動到觸控／鍵盤／手寫（${device.slice(0, 3).join("、")}${device.length > 3 ? "…" : ""}），「證據」或「沒測到什麼」要寫實機的情況`);
  }
  return problems;
}

/** 這張 PR 要不要驗收卡：在 CARD_REQUIRED_FROM（含）之後開的才要。createdAt 是 GitHub 的 ISO 時間。 */
export const cardRequired = (createdAt) => typeof createdAt === "string" && createdAt.slice(0, 10) >= CARD_REQUIRED_FROM;

// CLI（public-push.sh 用）：PR_JSON='{"body":…,"createdAt":…}' node scripts/prCardLib.mjs <改到的檔…>
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const pr = JSON.parse(process.env.PR_JSON || "{}");
  if (!cardRequired(pr.createdAt)) process.exit(0);
  const problems = cardProblems(pr.body, process.argv.slice(2));
  if (problems.length === 0) process.exit(0);
  console.error(`驗收卡不完整（寫法見 scripts/prCardLib.mjs 與 .github/pull_request_template.md）：\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
