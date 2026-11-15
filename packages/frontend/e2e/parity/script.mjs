// 劇本：同一套操作，只用 HTTP API（App 自己用的那組端點），三個宿主各跑一遍再比對。
// 每個 `api.call` 是一步；回應會被記下來，之後正規化再與 Node 後端那一欄比對（compare.mjs）。
// 劇本不知道自己跑在哪個宿主：宿主轉接器（hosts/*.mjs）只提供 request()。
//
// 步驟名稱就是已知差異清單（scripts/parity-known-differences-baseline.json）指向的鍵，不要隨便改名。
import { createHash } from "node:crypto";
import { inboxArea } from "./areas/inbox.mjs";
import { syncArea, queryArea, dayArea } from "./areas/reads.mjs";
import { historyArea, linksArea } from "./areas/history.mjs";
import { spacesArea, settingsArea } from "./areas/spaces.mjs";
import { importExportArea, backupArea } from "./areas/io.mjs";
import { miscArea, searchArea } from "./areas/misc.mjs";

// 一張 1x1 PNG 與一份很小的手寫（ink_data）資料；內容固定，三個宿主上傳同樣的位元組。
import { PNG_1X1 } from "./areas/util.mjs";
export { PNG_1X1 };
const INK = JSON.stringify({ version: 1, strokes: [{ id: "s1", points: [[0, 0], [10, 10], [20, 5]] }], erased: {}, page: { width: 1000 } });

/** @param {import("./run.mjs").Api} api */
export async function runScript(api) {
  // 開發時只跑某幾區：`--only inbox,sync`（略過原本 75 步；各區自己建立需要的筆記）。
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
  const ctx = {};
  if (only) { await runAreas(api, ctx, only); return; }
  const { call, name } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);

  // ── 筆記：建立、改、樹狀、移動、刪除、復原 ───────────────────────────────
  const createdA = (await call("建立 A（含連結與中文）", "POST", "/api/nodes", { json: { title: "計畫 Alpha", markdown: "第一段 plan overview\n\n連到 [[Beta 筆記]] 與 [[不存在的筆記]]。" } })).body;
  const A = name("A", createdA.id);
  name("workspace", createdA.workspace_id);
  name("space:personal", createdA.space_id);
  const B = name("B", (await call("建立 B", "POST", "/api/nodes", { json: { title: "Beta 筆記", markdown: "beta body text\n\n## 小節\n\n獨一無二的段落 zebra crossing 在這裡。" } })).body.id);
  const C = name("C", (await call("建立 C（A 的子筆記）", "POST", "/api/nodes", { json: { title: "Gamma child", markdown: "child body", parent_id: A } })).body.id);
  const Z = name("Z", (await call("建立 Z", "POST", "/api/nodes", { json: { title: "Zeta temp", markdown: "to be deleted" } })).body.id);

  await call("改 A 的標題與內文", "PATCH", `/api/nodes/${A}`, { json: { title: "計畫 Alpha v2", markdown: "第一段 plan overview 改過\n\n連到 [[Beta 筆記]] 與 [[Gamma child]]。\n\n- [ ] 內文裡的待辦" } });
  await call("只改 B 的標題（內文不變）", "PATCH", `/api/nodes/${B}`, { json: { title: "Beta 筆記 改名" } });
  name("actor:me", (await get("讀 A", `/api/nodes/${A}`)).body.last_actor);
  await get("讀 B", `/api/nodes/${B}`);
  await call("把 C 移到 B 底下", "PATCH", `/api/nodes/${C}`, { json: { parent_id: B } });
  await get("讀 C（移動後）", `/api/nodes/${C}`);

  await call("刪除 Z（進垃圾桶）", "DELETE", `/api/nodes/${Z}`);
  await get("讀已刪除的 Z", `/api/nodes/${Z}`);
  await call("復原 Z", "POST", `/api/nodes/${Z}/undelete`);
  await get("讀復原後的 Z", `/api/nodes/${Z}`);
  await call("刪除 C 與其子樹", "DELETE", `/api/nodes/${C}`);
  await call("復原 C", "POST", `/api/nodes/${C}/undelete`);

  // ── 標籤與標籤欄位 ──────────────────────────────────────────────────────
  const tag = name("tag:project", (await call("建立標籤 對照專案", "POST", "/api/tags", { json: { name: "對照專案" } })).body.id);
  const child = name("tag:project/phase", (await call("建立巢狀標籤 對照專案/階段", "POST", "/api/tags/resolve-path", { json: { path: "對照專案/階段" } })).body.leaf_id);
  await call("標籤 project 加欄位", "PATCH", `/api/tags/${tag}/schema`, {
    json: { fields: [
      { name: "owner", type: "text" },
      { name: "points", type: "number" },
      { name: "labels", type: "select", options: ["db", "ml", "web"], cardinality: "many" },
    ] },
  });
  await call("A 套用標籤 project", "PUT", `/api/nodes/${A}/tags/${tag}`);
  await call("A 再套一次（沒有變化）", "PUT", `/api/nodes/${A}/tags/${tag}`);
  await call("B 套用標籤 project", "PUT", `/api/nodes/${B}/tags/${tag}`);
  await call("B 移除標籤 project", "DELETE", `/api/nodes/${B}/tags/${tag}`);
  await get("標籤 project 的細節", `/api/tags/${tag}`);

  // ── 屬性（含多值）──────────────────────────────────────────────────────
  await call("A 設欄位 owner", "PUT", `/api/nodes/${A}/attributes/owner`, { json: { value: "小明" } });
  await call("A 設欄位 points（數字）", "PUT", `/api/nodes/${A}/attributes/points`, { json: { value: 8 } });
  await call("A 設多值欄位 labels", "PUT", `/api/nodes/${A}/attributes/labels`, { json: { value: JSON.stringify(["db", "ml"]) } });
  await call("A 設欄位 labels 不合法的選項", "PUT", `/api/nodes/${A}/attributes/labels`, { json: { value: JSON.stringify(["db", "nope"]) } });
  await call("A 設自由屬性 mood", "PUT", `/api/nodes/${A}/attributes/mood`, { json: { value: "good" } });
  await call("A 刪自由屬性 mood", "DELETE", `/api/nodes/${A}/attributes/mood`);
  await get("讀 A 的屬性", `/api/nodes/${A}/attributes`, { unordered: true });

  // ── 連結與反向連結 ──────────────────────────────────────────────────────
  const boot1 = await get("全部狀態（連結、屬性、標籤）", "/api/bootstrap", { project: api.projectBootstrap });
  void boot1;

  // ── 任務 ────────────────────────────────────────────────────────────────
  const task = name("task:報告", (await call("建立任務（日期、重複）", "POST", "/api/tasks", { json: { title: "寫報告", when_date: "2026-12-01", recur: "1w" } })).body.id);
  const task2 = name("task:買牛奶", (await call("建立任務（無日期）", "POST", "/api/tasks", { json: { title: "買牛奶" } })).body.id);
  await call("改任務日期", "PATCH", `/api/tasks/${task2}`, { json: { when_date: "2026-12-05", deadline: "2026-12-09" } });
  await call("勾選重複任務（要排下一次）", "PATCH", `/api/tasks/${task}`, { json: { status: "done" } });
  await call("勾選一次性任務", "PATCH", `/api/tasks/${task2}`, { json: { status: "done" } });
  name("task:筆記裡", (await call("在筆記底下加任務", "POST", `/api/nodes/${B}/tasks`, { json: { title: "筆記裡的任務", when_date: "2026-12-03" } })).body.id);
  await get("任務議程", "/api/tasks/agenda", { project: api.projectAgenda });

  // ── 白板卡片位置 ────────────────────────────────────────────────────────
  const canvas = name("canvas", (await call("建立白板", "POST", "/api/canvases", { json: { title: "白板一號" } })).body.id);
  await call("白板放兩張卡片與一個區塊", "PATCH", `/api/boards/${canvas}`, {
    json: { cards: { upsert: [{ nodeId: A, x: 10, y: 20, width: 200, height: 100 }, { nodeId: B, x: 300.5, y: -40, color: "#ff0000", folded: true }] }, sections: { upsert: [{ id: "sec1", title: "區塊", x: 0, y: 0, width: 500, height: 400 }] } },
  });
  await call("移動卡片 A、移除卡片 B", "PATCH", `/api/boards/${canvas}`, { json: { cards: { upsert: [{ nodeId: A, x: 15, y: 25 }], remove: [B] } } });
  await get("讀白板", `/api/boards/${canvas}`, { unordered: true });
  await get("讀白板（canvases 舊入口）", `/api/canvases/${canvas}`);

  // ── 手寫（ink_data）──────────────────────────────────────────────────────
  await call("C 存手寫", "PUT", `/api/nodes/${C}/attributes/ink_data`, { json: { value: INK, value_type: "text" } });
  await get("讀手寫版本", `/api/nodes/${C}/ink-versions?kind=handwriting`, { project: api.projectInk });
  await get("讀 C 的手寫屬性", `/api/nodes/${C}/attributes?keys=ink_data`);

  // ── 上傳圖片 ────────────────────────────────────────────────────────────
  const up = await call("上傳圖片", "POST", "/api/media", { upload: { name: "dot.png", type: "image/png", bytes: PNG_1X1 } });
  const url = up.body?.url ?? "";
  const mediaId = String(url).split("/").pop();
  api.rename(mediaId, "media:dot");
  const img = await call("下載上傳的圖片", "GET", String(url), { binary: true, project: (r) => ({ contentType: r.contentType, nonEmpty: (r.bytes?.length ?? 0) > 0 }) });
  void img;
  await call("筆記內文放圖片", "PATCH", `/api/nodes/${C}`, { json: { markdown: `child body\n\n![dot](${url})` } });
  await call("上傳不支援的檔案類型", "POST", "/api/media", { upload: { name: "x.exe", type: "application/octet-stream", bytes: Buffer.from("MZ") } });

  // ── 段落連結 [[筆記/段落]] ─────────────────────────────────────────────
  const bodyB = (await get("讀 B 的內文（段落連結前）", `/api/nodes/${B}`)).body.markdown;
  const at = bodyB.indexOf("獨一無二的段落");
  const bl = await call("建立段落連結", "POST", `/api/nodes/${B}/block-links`, { json: { source_note_id: A, at, seen_text: "獨一無二的段落 zebra crossing 在這裡。" } });
  if (bl.status === 201) {
    name("anchor:B段落", bl.body.anchor_id);
    await call("A 寫入段落連結", "PATCH", `/api/nodes/${A}`, { json: { markdown: `第一段 plan overview 改過\n\n參考 [[${bl.body.link}]]。` } });
  }
  await get("B 的段落", `/api/nodes/${B}/paragraphs`);
  await get("B 的段落連結計數", `/api/nodes/${B}/block-link-counts`);

  // ── 搜尋（中文與英文）───────────────────────────────────────────────────
  await get("搜尋英文詞 zebra", `/api/nodes/search?q=${encodeURIComponent("zebra")}`, { project: api.projectSearch });
  await get("搜尋中文詞 計畫", `/api/nodes/search?q=${encodeURIComponent("計畫")}`, { project: api.projectSearch });
  await get("搜尋中文片語 段落", `/api/nodes/search?q=${encodeURIComponent("段落")}`, { project: api.projectSearch });
  await get("搜尋 AND 兩個詞", `/api/nodes/search?q=${encodeURIComponent("plan overview")}`, { project: api.projectSearch });
  await get("搜尋找不到", `/api/nodes/search?q=${encodeURIComponent("nonexistentwordxyz")}`, { project: api.projectSearch });
  await get("搜尋過短（1 個字）", `/api/nodes/search?q=${encodeURIComponent("a")}`);

  // ── 歷史版本 ────────────────────────────────────────────────────────────
  const versions = await get("A 的版本列表", `/api/nodes/${A}/versions`, { project: api.projectVersions });
  await get("A 的歷史", `/api/nodes/${A}/history`, { project: api.projectVersions });
  const oldest = versions.body?.[versions.body.length - 1];
  if (oldest?.id) {
    await call("還原 A 到最早版本", "POST", `/api/nodes/${A}/versions/${oldest.id}/restore`);
    await get("讀還原後的 A", `/api/nodes/${A}`);
  }

  // ── 匯出與最近變更 ──────────────────────────────────────────────────────
  await call("匯出 A 的 Markdown 預覽", "POST", `/api/nodes/${A}/export-preview`, { json: { format: "markdown" } });
  await get("最近變更的版本", "/api/versions/recent?limit=100", { project: (r) => ({ count: r.body?.items?.length ?? r.body?.length, titles: (r.body?.items ?? r.body ?? []).map?.((v) => v.title).filter((t) => ["計畫 Alpha", "Beta 筆記 改名", "Gamma child", "Zeta temp"].includes(t)).sort() }) });

  // ── 宿主能力：文件上寫的差異就在這幾步（docs/architecture/browser-app.md §7、docs/desktop/README.md）──────────
  const shape = (r) => ({ contentType: r.contentType, body: typeof r.body === "string" ? "(文字)" : r.body });
  await get("AI：金鑰能不能存放（ONDEN_SECRET_KEY）", "/api/ai/status");
  await get("推播：公開金鑰", "/api/push/key");
  await call("稍後閱讀：抓網頁標題", "POST", "/api/bookmark/preview", { json: { url: "http://localhost:9/" } });
  await get("外部行事曆：清單", "/api/external-calendars");
  await get("RSS：來源清單", "/api/rss/sources");
  await get("首頁網站 /site/feed.xml", "/site/feed.xml", { project: (r) => ({ status: r.status, html: typeof r.body === "string" && r.body.includes("<html") }) });
  void shape;

  // ── 完整備份 zip 的內容 ────────────────────────────────────────────────
  const zip = await call("下載完整備份", "GET", "/api/backup/full.zip", { binary: true, project: api.projectZip });
  void zip;
  void child;
  void createHash;
  await runAreas(api, ctx, null);
}

// 新增的各區（每區都是 讀＋寫＋檢查結果）。順序有意義：備份還原放最後，因為它會換掉整個工作區的內容。
const AREAS = [["inbox", inboxArea], ["sync", syncArea], ["query", queryArea], ["day", dayArea], ["history", historyArea], ["links", linksArea], ["spaces", spacesArea], ["settings", settingsArea], ["io", importExportArea], ["misc", miscArea], ["search", searchArea], ["backup", backupArea]];
async function runAreas(api, ctx, only) {
  for (const [id, run] of AREAS) if (!only || only.includes(id)) await run(api, ctx);
}
