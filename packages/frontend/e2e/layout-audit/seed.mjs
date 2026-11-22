// The fixed data every screen is audited with. Fixed ids and strings (nothing from Date.now()), created through the
// app's own routes from inside the page (the browser app's backend runs in the page's worker), so they are ordinary notes.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const IDS = {
  long: id(101), parent: id(102), childA: id(103), childB: id(104), childC: id(105), longTitle: id(106),
  taggedTag: id(201), projectTag: id(202), tableNote: id(107), taskNote: id(108), canvasNote: id(109), slidesNote: id(110),
  deepChild: id(111),
};

const LONG_BODY = [
  "## 第一節：為什麼要寫",
  "",
  "這是一段固定的長內文，用來檢查標題、段落、清單、引用與程式碼在各個寬度的排版。".repeat(3),
  "",
  "- 第一個清單項目，文字稍微長一點，看看換行後的縮排是否整齊",
  "- 第二個清單項目",
  "  - 巢狀的清單項目",
  "- 第三個清單項目 [[快速上手]]",
  "",
  "> 一段引用：好的版面沒有驚喜，每個元素都在它該在的地方。",
  "",
  "## 第二節：程式碼與表格",
  "",
  "```ts",
  "const longLine = 'a very long line of code that goes on and on and on and on and on and on and on and on';",
  "```",
  "",
  "| 欄位 | 說明 | 備註 |",
  "| --- | --- | --- |",
  "| a | 第一列 | 備註一 |",
  "| b | 第二列 | 備註二 |",
  "",
  "## 第三節：任務",
  "",
  "- [ ] 寫完版面檢查 {task}",
  "- [ ] 整理報告 {task}",
  "- [x] 建立固定資料 {task}",
  "",
  "## 第四節：結尾",
  "",
  "最後一段文字。".repeat(20),
].join("\n");

async function post(page, path, body) {
  const result = await page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, text: (await r.text()).slice(0, 200) };
  }, { path, body });
  if (result.status >= 300 && result.status !== 409) throw new Error(`seed ${path} → ${result.status} ${result.text}`);
}

export async function seedFixedData(page) {
  await post(page, "/api/tags", { id: IDS.taggedTag, name: "版面測試" });
  await post(page, "/api/tags", { id: IDS.projectTag, name: "專案" });
  await post(page, "/api/nodes", { id: IDS.long, title: "版面檢查用的長筆記", markdown: LONG_BODY, tag_ids: [IDS.taggedTag, IDS.projectTag] });
  await post(page, "/api/nodes", { id: IDS.parent, title: "有子筆記的父筆記", markdown: "父筆記的內文。\n\n[[版面檢查用的長筆記]]", tag_ids: [IDS.projectTag] });
  await post(page, "/api/nodes", { id: IDS.childA, parent_id: IDS.parent, title: "子筆記甲", markdown: "子筆記甲的內文。" });
  await post(page, "/api/nodes", { id: IDS.childB, parent_id: IDS.parent, title: "子筆記乙：標題很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長", markdown: "子筆記乙的內文。" });
  await post(page, "/api/nodes", { id: IDS.childC, parent_id: IDS.parent, title: "子筆記丙", markdown: "子筆記丙的內文。" });
  await post(page, "/api/nodes", { id: IDS.deepChild, parent_id: IDS.childA, title: "孫筆記", markdown: "孫筆記的內文。" });
  await post(page, "/api/nodes", { id: IDS.longTitle, title: "這是一則標題非常非常長的筆記，長到在側欄裡一定會超出一行，用來檢查長標題在筆記樹、列表與標題列的處理方式", markdown: "內文。" });
  await post(page, "/api/nodes", { id: IDS.taskNote, title: "任務清單", markdown: "- [ ] 逾期的任務 {task}\n- [ ] 今天的任務 {task}\n- [ ] 很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長的任務名稱 {task}\n- [x] 完成的任務 {task}" });
  await post(page, "/api/nodes", { id: IDS.slidesNote, title: "簡報用筆記", markdown: "## 第一頁\n\n- 重點一\n- 重點二\n\n## 第二頁\n\n內容\n" });
}

// ── Data only the style census adds (layout-audit/run.mjs never calls this; screens with `census: true` use it) ──
// Everything is generated here: no real names, addresses or files.
export const CENSUS_IDS = { callouts: id(301), image: id(302), ink: id(303), pdf: id(304), day: id(305), empty: id(306) };

/** A one-page PDF with real text, built with correct byte offsets so pdf.js draws it. */
function makePdf() {
  const stream = "BT /F1 22 Tf 72 740 Td (Generated page) Tj 0 -34 Td /F1 12 Tf (Body text of a page made by the test.) Tj ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>", `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const INK = {
  version: 1, page: { width: 1000 },
  strokes: [
    { id: "s1", toolId: "pen", color: "#1a1a1a", size: 3, points: [[80, 120], [160, 90, 0.6], [240, 130, 0.7], [320, 90], [400, 120]] },
    { id: "s2", toolId: "pen", color: "#1a1a1a", size: 3, points: [[80, 200], [200, 210], [340, 195], [460, 215]] },
    { id: "s3", toolId: "highlighter", color: "#ffd54a", size: 14, points: [[80, 290], [460, 292]] },
  ],
  erased: {},
  shapes: [{ id: "h1", kind: "rectangle", start: [520, 90], end: [760, 230], color: "#c0392b", size: 2, fill: "none" }, { id: "h2", kind: "arrow", start: [520, 300], end: [760, 360], color: "#2471a3", size: 2 }],
};

export async function seedCensusData(page) {
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await post(page, "/api/nodes", { id: CENSUS_IDS.callouts, title: "提示框與各種區塊", markdown: [
    "> [!note] 一般提示", "> 這是一個提示框的內文。", "", "> [!warning] 注意", "> 這件事要小心。", "", "> [!tip]- 收合的小技巧", "> 展開後才看得到。", "",
    "> [!question] 問題", "> 為什麼要這樣？", "", "### 三級標題", "", "1. 有序清單一", "2. 有序清單二", "", "行內 `程式碼`、**粗體**、*斜體*、~~刪除線~~、==螢光==。", "", "---", "", "最後一段。"].join("\n"), tag_ids: [IDS.projectTag] });
  await post(page, "/api/nodes", { id: CENSUS_IDS.ink, title: "手寫頁", markdown: "", attributes: [{ key: "ink_data", value: JSON.stringify(INK), value_type: "text" }] });
  await post(page, "/api/nodes", { id: CENSUS_IDS.pdf, title: "產生的 PDF", markdown: "", attributes: [{ key: "pdf_url", value: `data:application/pdf;base64,${await page.evaluate((t) => btoa(t), makePdf())}`, value_type: "text" }] });
  // An image made in the page (a canvas), uploaded like any file.
  const url = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 360;
    const g = c.getContext("2d"); const grad = g.createLinearGradient(0, 0, 640, 360); grad.addColorStop(0, "#7aa6c2"); grad.addColorStop(1, "#e3c9a8");
    g.fillStyle = grad; g.fillRect(0, 0, 640, 360); g.fillStyle = "#ffffff"; g.beginPath(); g.arc(320, 180, 70, 0, 7); g.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png")); const f = new FormData(); f.append("file", new File([blob], "generated.png", { type: "image/png" }));
    const r = await fetch("/api/media", { method: "POST", body: f }); return (await r.json()).url;
  });
  await post(page, "/api/nodes", { id: CENSUS_IDS.image, title: "有圖片的筆記", markdown: `一張產生的圖片：\n\n![產生的圖片](${url})\n\n圖片下面的文字。` });
  await post(page, "/api/nodes", { id: CENSUS_IDS.day, title: today, markdown: "## 今天\n\n- 早上寫了一段筆記\n- 下午整理了標籤\n\n[[版面檢查用的長筆記]]" });
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  for (const t of [
    { title: "逾期的任務", when_date: day(-3) }, { title: "今天要做的任務", when_date: day(0) }, { title: "今天傍晚的任務", when_date: day(0), evening: true },
    { title: "每週重複的任務", when_date: day(0), recur: "1w" }, { title: "有時間的任務", when_date: day(0), time: "15:00", until: "16:00" },
    { title: "下週的任務", when_date: day(5) }, { title: "有期限的任務", deadline: day(9) }, { title: "隨時可做的任務", someday: true },
  ]) await post(page, "/api/tasks", t);
  await page.evaluate(async () => { await fetch("/api/workspace/modules", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ module: "ai", imported: true }) }); });
}
