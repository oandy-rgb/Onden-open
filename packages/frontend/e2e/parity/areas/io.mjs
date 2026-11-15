// 區 10、11：匯入與匯出（Markdown、圖片、[[連結]]、zip）、備份下載與還原。
import { unzipSync, strFromU8 } from "fflate";
import { PNG_1X1, makeNote, nameIf, scrubText, scrubPath } from "./util.mjs";

const unzipView = (api, bytes, pick) => {
  let files;
  try { files = unzipSync(new Uint8Array(bytes)); } catch (e) { return { notZip: String(e.message).slice(0, 60) }; }
  const out = {};
  for (const [path, data] of Object.entries(files)) {
    const text = /\.(md|txt|json|yaml|yml)$/.test(path) ? strFromU8(data) : null;
    const hit = pick(path, text, data);
    if (hit !== undefined) out[hit.key] = hit.value;
  }
  return Object.fromEntries(Object.entries(out).sort());
};

export async function importExportArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  await get("匯入：可用的來源", "/api/import/sources", { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  const files = [
    { path: "匯入庫/匯入筆記.md", content: "---\ntags: [匯入標籤]\n---\n# 匯入筆記\n\n這是匯入的 importword，連到 [[匯入的另一篇]] 與 [[不存在的匯入連結]]。\n\n![小圖](點.png)\n\n- [ ] 匯入的待辦\n" },
    { path: "匯入庫/匯入的另一篇.md", content: "另一篇的內容\n" },
    { path: "匯入庫/點.png", base64: PNG_1X1.toString("base64"), kind: "image" },
    { path: "匯入庫/說明.txt", content: "不支援的檔案" },
  ];
  const imp = await call("匯入：匯入資料夾（Markdown、圖片、連結）", "POST", "/api/import/obsidian", {
    json: { files, source: { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "對照匯入庫" } },
    project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).sort(), imported: r.body?.imported ?? r.body?.notes, skipped: r.body?.skipped?.length, images: Object.keys(r.body?.image_urls ?? {}).length }),
  });
  void imp;
  const find = async (q, label) => {
    const hits = (await call(`匯入：搜尋 ${q}`, "GET", `/api/nodes/search?q=${encodeURIComponent(q)}`, { project: (r) => ({ titles: (r.body ?? []).map((x) => x.title).sort() }) })).body ?? [];
    return nameIf(api, label, hits.find((h) => h.title === q)?.id);
  };
  const folder = await find("匯入庫", "imp:資料夾");
  const noteId = await find("匯入筆記", "imp:筆記");
  const otherId = await find("匯入的另一篇", "imp:另一篇");
  if (noteId) {
    await get("匯入：匯入後的內文", `/api/nodes/${noteId}`, { project: (r) => ({ title: r.body?.title, markdown: String(r.body?.markdown ?? "").replace(/\/api\/media\/[^\s)]+/g, "/api/media/<media>") }) });
    await get("匯入：標籤與屬性", `/api/nodes/${noteId}/attributes`, { project: (r) => ({ keys: (Array.isArray(r.body) ? r.body : []).map((a) => a.key).filter((k) => !k.startsWith("_import")).sort(), import_keys: (Array.isArray(r.body) ? r.body : []).filter((a) => a.key.startsWith("_import")).length > 0 }) });
    await get("匯入：連結圖", "/api/sync?since=0", { project: (r) => ({ edges: (r.body?.edges?.upsert ?? []).filter((e) => e.source_node_id === noteId).map((e) => [api.names.get(e.target_node_id) ?? "(未命名)", e.edge_type]).sort() }) });
    await get("匯入：匯入的待辦", "/api/tasks/agenda", { project: (r) => ({ titles: Object.values(r.body?.buckets ?? {}).flat().filter((t) => t.title === "匯入的待辦").length }) });
    await call("匯入：再匯入一次（沒開更新＝多一份副本）", "POST", "/api/import/obsidian", { json: { files, source: { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "對照匯入庫" } }, project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
    await call("匯入：再匯入後有兩篇同名", "GET", `/api/nodes/search?q=${encodeURIComponent("匯入筆記")}`, { project: (r) => ({ n: (r.body ?? []).filter((x) => x.title === "匯入筆記").length }) });
    // 副本的收尾：之後的匯出與備份不要有同名筆記（同名時資料夾與檔名的編號順序沒有規定）。副本與它的資料夾丟進垃圾桶再永久刪除。
    for (const title of ["匯入庫", "匯入筆記", "匯入的另一篇"]) {
      const hits = (await call(`匯入：找出「${title}」的副本`, "GET", `/api/nodes/search?q=${encodeURIComponent(title)}`, { project: (r) => ({ copies: (r.body ?? []).filter((x) => x.title === title && !api.names.has(x.id)).length }) })).body ?? [];
      for (const copy of hits.filter((x) => x.title === title && !api.names.has(x.id))) {
        await call(`匯入：刪除副本 ${title}`, "DELETE", `/api/nodes/${copy.id}`, { project: (r) => ({ status: r.status }) });
        const plan = (await call(`匯入：永久刪除副本前預覽 ${title}`, "GET", `/api/nodes/${copy.id}/purge-preview`, { project: (r) => ({ status: r.status }) })).body;
        if (plan?.ids) await call(`匯入：永久刪除副本 ${title}`, "POST", `/api/nodes/${copy.id}/purge`, { json: { expected_ids: plan.ids }, project: (r) => ({ status: r.status }) });
      }
    }
    await call("匯入：開更新再匯入（改內文）", "POST", "/api/import/obsidian", { json: { upsert: true, source: { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "對照匯入庫" }, files: [{ path: "匯入庫/匯入的另一篇.md", content: "另一篇改過 upsertword\n" }] }, project: (r) => ({ status: r.status, error: r.body?.error, counts: Object.fromEntries(Object.entries(r.body ?? {}).filter(([, v]) => typeof v === "number" && v > 0)), conflicts: r.body?.conflicts, skipped: r.body?.skipped }) });
    const src2 = { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "對照單檔來源" };
    await call("匯入：單檔第一次匯入", "POST", "/api/import/obsidian", { json: { source: src2, files: [{ path: "更新用.md", content: "更新前 beforeword\n" }] }, project: (r) => ({ status: r.status, skipped: r.body?.skipped ?? 0 }) });
    await call("匯入：單檔開更新再匯入", "POST", "/api/import/obsidian", { json: { upsert: true, source: src2, files: [{ path: "更新用.md", content: "更新後 afterword\n" }] }, project: (r) => ({ status: r.status, skipped: r.body?.skipped ?? 0, conflicts: r.body?.conflicts }) });
    await call("匯入：單檔更新後只有新內容", "GET", `/api/nodes/search?q=${encodeURIComponent("afterword")}`, { project: (r) => ({ titles: (r.body ?? []).map((x) => x.title) }) });
    await call("匯入：單檔舊內容已被取代", "GET", `/api/nodes/search?q=${encodeURIComponent("beforeword")}`, { project: (r) => ({ n: (r.body ?? []).length }) });
    await call("匯入：開更新但沒有來源（拒絕）", "POST", "/api/import/obsidian", { json: { upsert: true, files: [{ path: "x.md", content: "x" }] }, project: (r) => ({ status: r.status }) });
    await call("匯入：更新後的搜尋", "GET", `/api/nodes/search?q=${encodeURIComponent("upsertword")}`, { project: (r) => ({ n: (r.body ?? []).length, titles: (r.body ?? []).map((x) => x.title).sort() }) });
  }
  await call("匯入：沒有檔案（拒絕）", "POST", "/api/import/obsidian", { json: { files: [] }, project: (r) => ({ status: r.status }) });
  await call("匯入：路徑重複（拒絕）", "POST", "/api/import/obsidian", { json: { files: [{ path: "a.md", content: "x" }, { path: "a.md", content: "y" }] }, project: (r) => ({ status: r.status }) });

  // ── 匯出 ───────────────────────────────────────────────────────────────
  const exp = noteId ?? otherId;
  if (exp) {
    const cur = (await call("匯出：讀要匯出的筆記", "GET", `/api/nodes/${exp}`, { project: () => ({}) })).body ?? {};
    const snap = { title: cur.title ?? "", markdown: cur.markdown ?? "" };
    await call("匯出：筆記的 Markdown 預覽", "POST", `/api/nodes/${exp}/export-preview`, { json: { ...snap, format: "markdown" }, project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort(), text: typeof r.body?.markdown === "string" ? r.body.markdown.replace(/\/api\/media\/[^\s)]+/g, "/api/media/<media>").slice(0, 400) : undefined }) });
    await call("匯出：筆記的 HTML 預覽", "POST", `/api/nodes/${exp}/export-preview`, { json: { ...snap, format: "html" }, project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
    await call("匯出：不認得的格式（拒絕）", "POST", `/api/nodes/${exp}/export-preview`, { json: { ...snap, format: "docx" }, project: (r) => ({ status: r.status }) });
    await get("匯出：單篇 HTML", `/api/nodes/${exp}/export.html`, { project: (r) => ({ status: r.status, contentType: r.contentType, hasTitle: typeof r.body === "string" && r.body.includes("匯入") }) });
  }
  const mine = (title) => ["匯入筆記", "匯入的另一篇", "計畫 Alpha v2", "Beta 筆記 改名", "空間搬家", "復原三行", "連結來源", "查詢對照", "Q-甲"].includes(title);
  await call("匯出：整個工作區的 Markdown zip", "GET", "/api/export/markdown.zip", {
    binary: true,
    project: (r) => ({ contentType: r.contentType, files: unzipView(api, r.bytes ?? [], (path, text, data) => {
      const base = path.replace(/\.md$/, "").split("/").pop();
      if (path.endsWith(".md") && mine(base)) return { key: scrubPath(path), value: scrubText(text).replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^"\s]*/g, "<time>") };
      if (!path.endsWith(".md") && !path.endsWith(".txt")) return { key: `(非筆記檔)${scrubPath(path)}`, value: true };
      return undefined;
    }) }),
  });
}

// ── 區 11：備份下載 → 上傳還原 → 預覽 → 套用 → 等工作完成 → 比對 ────────────────
export async function backupArea(api, ctx) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const personal = ctx.personalSpace ?? (await call("備份：取個人空間（命名用）", "GET", "/api/spaces", { project: () => ({}) })).body?.spaces?.find((s) => s.kind === "personal")?.id;
  nameIf(api, "space:personal", personal);

  // 還原前先蓋出有代表性的內容：筆記、標籤與欄位、屬性、白板、手寫、附件
  const src = await makeNote(api, "備份：建立要備份的筆記", "bk:筆記", { title: "備份來源筆記", markdown: "備份內文 backupword\n\n連到 [[備份另一篇]]", space_id: personal });
  const other = await makeNote(api, "備份：建立另一篇", "bk:另一篇", { title: "備份另一篇", markdown: "另一篇", space_id: personal });
  const tag = nameIf(api, "tag:bk", (await call("備份：建立標籤", "POST", "/api/tags", { json: { name: "備份標籤" }, project: (r) => ({ status: r.status }) })).body?.id);
  await call("備份：標籤欄位", "PATCH", `/api/tags/${tag}/schema`, { json: { fields: [{ name: "rating", type: "number" }] }, project: (r) => ({ status: r.status }) });
  await call("備份：套用標籤", "PUT", `/api/nodes/${src}/tags/${tag}`, { project: (r) => ({ status: r.status }) });
  await call("備份：設屬性 rating", "PUT", `/api/nodes/${src}/attributes/rating`, { json: { value: 4 }, project: (r) => ({ status: r.status }) });
  await call("備份：設自由屬性", "PUT", `/api/nodes/${src}/attributes/source_url`, { json: { value: "https://example.com/a" }, project: (r) => ({ status: r.status }) });
  const board = nameIf(api, "bk:白板", (await call("備份：建立白板", "POST", "/api/canvases", { json: { title: "備份白板" }, project: (r) => ({ status: r.status }) })).body?.id);
  await call("備份：白板放卡片", "PATCH", `/api/boards/${board}`, { json: { cards: { upsert: [{ nodeId: src, x: 12, y: 34, width: 200, height: 100 }, { nodeId: other, x: 300, y: 60 }] } }, project: (r) => ({ status: r.status }) });
  const ink = await makeNote(api, "備份：建立手寫頁", "bk:手寫", { title: "備份手寫", markdown: "", space_id: personal });
  const INK = JSON.stringify({ version: 1, strokes: [{ id: "s1", points: [[0, 0], [10, 10], [20, 5]] }], erased: {}, page: { width: 1000 } });
  await call("備份：存手寫", "PUT", `/api/nodes/${ink}/attributes/ink_data`, { json: { value: INK, value_type: "text" }, project: (r) => ({ status: r.status }) });
  const up = await call("備份：上傳附件圖片", "POST", "/api/media", { upload: { name: "bk.png", type: "image/png", bytes: PNG_1X1 }, project: (r) => ({ status: r.status }) });
  const url = up.body?.url ?? "";
  api.rename(String(url).split("/").pop(), "media:bk");
  await call("備份：筆記放附件", "PATCH", `/api/nodes/${src}`, { json: { markdown: `備份內文 backupword\n\n連到 [[備份另一篇]]\n\n![bk](${url})` }, project: (r) => ({ status: r.status }) });
  const gone = await makeNote(api, "備份：建立垃圾桶裡的筆記", "bk:垃圾桶", { title: "備份垃圾桶筆記", markdown: "已刪", space_id: personal });
  await call("備份：刪除", "DELETE", `/api/nodes/${gone}`, { project: (r) => ({ status: r.status }) });
  const task = await call("備份：建立任務", "POST", "/api/tasks", { json: { title: "備份任務", when_date: "2030-01-02", recur: "1w" }, project: (r) => ({ status: r.status }) });
  void task;

  // 標記用：只看劇本命名的東西；還原後它們會得到新 id，所以改用「標題」比對
  const state = (step) => get(step, "/api/bootstrap", {
    project: (r) => {
      const b = r.body ?? {};
      const titles = new Set(["備份來源筆記", "備份另一篇", "備份手寫", "備份白板"]);
      const nodes = (b.nodes ?? []).filter((n) => titles.has(n.title));
      const byId = new Map(nodes.map((n) => [n.id, n.title]));
      return {
        notes: nodes.map((n) => [n.title, n.node_type, n.markdown?.replace(/\/api\/media\/[^\s)]+/g, "/api/media/<media>"), n.deleted_at != null]).sort(),
        attrs: (b.attributes ?? []).filter((a) => byId.has(a.node_id) && !a.key.startsWith("_")).map((a) => [byId.get(a.node_id), a.key, a.value]).sort(),
        ink: (b.attributes ?? []).filter((a) => byId.has(a.node_id) && a.key === "ink_data").map((a) => [byId.get(a.node_id), a.value.length > 10]).sort(),
        tags: (b.nodes ?? []).filter((n) => n.title === "備份標籤").map((n) => [n.node_type, (n.tag_schema?.fields ?? []).map((f) => f.name)]),
        carriers: (b.nodes ?? []).filter((n) => byId.has(n.id)).map((n) => [n.title, (n.class_tag_ids ?? []).length + (n.label_tag_ids ?? []).length]).sort(),
        edges: (b.edges ?? []).filter((e) => byId.has(e.source_node_id)).map((e) => [byId.get(e.source_node_id), byId.get(e.target_node_id) ?? "(其他)", e.edge_type]).sort(),
        tasks: (b.tasks ?? []).filter((t) => t.title === "備份任務").map((t) => [t.title, t.when_date, t.recur]),
      };
    },
  });
  await state("備份：還原前的狀態");

  const dl = await call("備份：下載完整備份（還原用）", "GET", "/api/backup/full.zip", { binary: true, project: api.projectZip });
  const bytes = dl.bytes;
  if (!bytes?.length) return;

  const up2 = await call("備份：上傳備份檔", "POST", "/api/backup/restore/upload", { raw: { bytes, type: "application/zip" }, project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).sort(), manifest_keys: Object.keys(r.body?.manifest ?? {}).sort() }) });
  const uploadId = up2.body?.upload_id;
  if (!uploadId) return;
  nameIf(api, "restore:upload", uploadId);

  // 還原到一個新的共用空間（empty 模式要求目標沒有筆記）
  const target = nameIf(api, "space:restore", (await call("備份：建立還原目標空間", "POST", "/api/spaces", { json: { name: "還原目標" }, project: (r) => ({ status: r.status }) })).body?.id);
  const preview = (step, mode, space) => get(step, `/api/backup/restore/${uploadId}/preview?space=${space}&mode=${mode}`, { project: (r) => ({ status: r.status, error: r.body?.error, refusal: r.body?.refusal ?? null, mode: r.body?.mode, keys: Object.keys(r.body ?? {}).sort() }) });
  await preview("備份：預覽（新空間，empty 模式）", "empty", target);
  await preview("備份：預覽（個人空間已有筆記，empty 模式被拒）", "empty", personal);
  await preview("備份：預覽（搬整個工作區：已有筆記，被拒）", "workspace", personal);
  await get("備份：預覽的模式不合法", `/api/backup/restore/${uploadId}/preview?space=${target}&mode=nope`, { project: (r) => ({ status: r.status }) });
  const apply = await call("備份：套用還原（empty 模式）", "POST", `/api/backup/restore/${uploadId}/apply`, { json: { space_id: target, mode: "empty" }, project: (r) => ({ status: r.status, error: r.body?.error, job_status: r.body?.job?.status }) });
  const jobId = apply.body?.job?.id;
  if (jobId) {
    let job = apply.body.job;
    for (let i = 0; i < 120 && job?.status === "running"; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      job = (await call("備份：等還原工作完成", "GET", `/api/backup/restore/jobs/${jobId}`, { silent: true })).body?.job;
    }
    await get("備份：還原工作的結果", `/api/backup/restore/jobs/${jobId}`, { project: (r) => ({ status: r.status, job_status: r.body?.job?.status, error: r.body?.job?.error ?? null, keys: Object.keys(r.body?.job ?? {}).filter((k) => !/id$|_at$/.test(k)).sort() }) });
  }
  // 還原後：新空間裡出現一份（標題相同），原本的不動
  await get("備份：還原後新空間的筆記", "/api/bootstrap", {
    project: (r) => {
      const inTarget = (r.body?.nodes ?? []).filter((n) => n.space_id === target);
      const titles = new Set(["備份來源筆記", "備份另一篇", "備份手寫", "備份白板"]);
      const nodes = inTarget.filter((n) => titles.has(n.title));
      const byId = new Map(nodes.map((n) => [n.id, n.title]));
      return {
        notes: nodes.map((n) => [n.title, n.node_type, n.markdown?.replace(/\/api\/media\/[^\s)]+/g, "/api/media/<media>"), n.deleted_at != null]).sort(),
        attrs: (r.body?.attributes ?? []).filter((a) => byId.has(a.node_id) && !a.key.startsWith("_")).map((a) => [byId.get(a.node_id), a.key, a.value]).sort(),
        ink: (r.body?.attributes ?? []).filter((a) => byId.has(a.node_id) && a.key === "ink_data").map((a) => [byId.get(a.node_id), a.value.length > 10]).sort(),
        edges: (r.body?.edges ?? []).filter((e) => byId.has(e.source_node_id)).map((e) => [byId.get(e.source_node_id), byId.get(e.target_node_id) ?? "(其他)", e.edge_type]).sort(),
        tasks: (r.body?.tasks ?? []).filter((t) => t.title === "備份任務").map((t) => [t.title, t.when_date, t.recur]).length,
        tags: (r.body?.nodes ?? []).filter((n) => n.title === "備份標籤").length,
      };
    },
  });
  await state("備份：還原後兩個空間合起來的狀態");
  await call("備份：套用同一份上傳第二次", "POST", `/api/backup/restore/${uploadId}/apply`, { json: { space_id: target, mode: "empty" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("備份：丟掉上傳的備份檔", "DELETE", `/api/backup/restore/${uploadId}`, { project: (r) => ({ status: r.status }) });
  await get("備份：丟掉後預覽（找不到）", `/api/backup/restore/${uploadId}/preview?space=${target}&mode=empty`, { project: (r) => ({ status: r.status }) });
  await call("備份：上傳不是備份的檔案（拒絕）", "POST", "/api/backup/restore/upload", { raw: { bytes: Buffer.from("not a zip"), type: "application/zip" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
}
