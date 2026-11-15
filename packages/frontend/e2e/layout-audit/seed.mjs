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
