// 區 12、13：其他功能各一兩步（技能、段落指標、AI 工作階段、RSS、標籤管理、範本、簡報、PDF）；搜尋多幾種。
import { makeNote, nameIf, maskKeys } from "./util.mjs";

export async function miscArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const note = await makeNote(api, "其他：建立筆記", "misc:筆記", { title: "其他功能筆記", markdown: "其他功能的內容 miscword" });
  const other = await makeNote(api, "其他：建立第二篇", "misc:第二篇", { title: "其他功能第二篇", markdown: "第二篇" });


  // 技能清單、段落指標、AI 工作階段
  await get("技能：清單", "/api/skills", { project: (r) => ({ status: r.status, ids: (r.body?.skills ?? []).map((s) => s.id).sort(), builtin: (r.body?.skills ?? []).filter((s) => s.kind === "builtin").length }) });
  const ptr = await call("指標：把筆記放到另一篇底下", "POST", "/api/pointers", { json: { target_id: note, parent_id: other }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("指標：同一個位置再放一次（衝突）", "POST", "/api/pointers", { json: { target_id: note, parent_id: other }, project: (r) => ({ status: r.status }) });
  await call("指標：放到自己底下（拒絕）", "POST", "/api/pointers", { json: { target_id: note, parent_id: note }, project: (r) => ({ status: r.status }) });
  if (ptr.body?.id) await call("指標：刪除", "DELETE", `/api/pointers/${ptr.body.id}`, { project: (r) => ({ status: r.status }) });
  await get("AI 工作階段：這篇的列表", `/api/agent-sessions?node_id=${note}`, { project: (r) => ({ status: r.status, n: (r.body?.sessions ?? []).length }) });
  await get("AI 工作階段：角色清單", "/api/agent-sessions/runners", { project: (r) => ({ status: r.status, n: (r.body?.runners ?? []).length }) });
  await get("AI 工作階段：不存在的工作階段", "/api/agent-sessions/00000000-0000-4000-8000-0000000000cc", { project: (r) => ({ status: r.status }) });
  await get("AI 設定：金鑰與模型狀態", "/api/ai/status", { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });

  // RSS：只新增來源（OPML 不抓）、改、取消訂閱
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>對照</title></head><body><outline text="對照來源" title="對照來源" type="rss" xmlUrl="http://127.0.0.1:9/parity-feed.xml" htmlUrl="http://127.0.0.1:9/"/></body></opml>`;
  await call("RSS：開啟 RSS 模組", "PATCH", "/api/workspace/modules", { json: { module: "rss", imported: true }, project: (r) => ({ status: r.status, rss: (r.body?.modules ?? []).includes("rss") }) });
  const imp = await call("RSS：匯入 OPML（只新增來源，不抓）", "POST", "/api/rss/opml", { json: { opml }, project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).sort() }) });
  void imp;
  const sources = (await get("RSS：來源清單（新增後）", "/api/rss/sources", { project: (r) => ({ n: (r.body?.sources ?? r.body ?? []).length, titles: (r.body?.sources ?? r.body ?? []).map?.((s) => s.title)?.sort?.() }) })).body;
  const src = (sources?.sources ?? sources ?? []).find?.((s) => s.title === "對照來源");
  if (src?.id) {
    nameIf(api, "rss:source", src.id);
    await call("RSS：改抓取間隔", "PATCH", `/api/rss/sources/${src.id}`, { json: { fetch_interval_minutes: 120 }, project: (r) => ({ status: r.status }) });
    await call("RSS：取消訂閱（刪除來源）", "POST", `/api/rss/sources/${src.id}/unsubscribe`, { json: {}, project: (r) => ({ status: r.status }) });
    await get("RSS：取消後來源清單", "/api/rss/sources", { project: (r) => ({ n: (r.body?.sources ?? r.body ?? []).filter?.((s) => s.title === "對照來源").length }) });
  }
  await get("RSS：OPML 匯出", "/api/rss/opml", { project: (r) => ({ status: r.status, type: r.contentType }) });

  // 標籤改名／合併／搬移
  const ta = nameIf(api, "tag:merge-src", (await call("標籤：建立 合併來源", "POST", "/api/tags", { json: { name: "合併來源" }, project: (r) => ({ status: r.status }) })).body?.id);
  const tb = nameIf(api, "tag:merge-dst", (await call("標籤：建立 合併目標", "POST", "/api/tags", { json: { name: "合併目標" }, project: (r) => ({ status: r.status }) })).body?.id);
  const tc = nameIf(api, "tag:move", (await call("標籤：建立 要搬的標籤", "POST", "/api/tags", { json: { name: "要搬的標籤" }, project: (r) => ({ status: r.status }) })).body?.id);
  await call("標籤：筆記套用 來源", "PUT", `/api/nodes/${note}/tags/${ta}`, { project: (r) => ({ status: r.status }) });
  await call("標籤：第二篇套用 目標", "PUT", `/api/nodes/${other}/tags/${tb}`, { project: (r) => ({ status: r.status }) });
  await call("標籤：改名", "PATCH", `/api/tags/${tc}`, { json: { name: "搬完的標籤", color: "#3366ff" }, project: (r) => ({ status: r.status, name: r.body?.name, color: r.body?.color }) });
  await call("標籤：改成已存在的名字（衝突）", "PATCH", `/api/tags/${tc}`, { json: { name: "合併目標" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("標籤：搬到另一個標籤底下", "PATCH", `/api/nodes/${tc}`, { json: { parent_id: tb }, project: (r) => ({ status: r.status, parent: api.names.get(r.body?.parent_id) ?? r.body?.parent_id }) });
  await get("標籤：路徑", `/api/tags/${tc}/path`, { project: (r) => ({ status: r.status, path: JSON.stringify(r.body).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{uuid}") }) });
  await get("標籤：合併預覽", `/api/tags/${ta}/merge-preview?target=${tb}`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  await call("標籤：合併 來源 → 目標", "POST", `/api/tags/${ta}/merge`, { json: { target_id: tb }, project: (r) => ({ status: r.status, merged: r.body?.merged, gained: r.body?.members_gained_target, source_deleted: r.body?.source_deleted }) });
  await get("標籤：合併後目標的成員", `/api/nodes/${note}`, { project: (r) => ({ tags: (r.body?.label_tag_ids ?? []).concat(r.body?.class_tag_ids ?? []).filter((id) => api.names.has(id)).map((id) => api.names.get(id)) }) });
  await get("標籤：合併後來源讀不到", `/api/tags/${ta}`, { project: (r) => ({ status: r.status }) });
  await get("標籤：刪除預覽", `/api/tags/${tb}/delete-preview`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  await get("標籤：樹狀", "/api/tags/tree", { project: (r) => ({ status: r.status, has_moved: JSON.stringify(r.body).includes("搬完的標籤") }) });

  // 範本：套用標籤時展開的子筆記要用 TagPack 設定（template_children），不在這支劇本的範圍；這裡只測「複製筆記當範本」。
  await call("範本：複製筆記當範本用", "POST", `/api/nodes/${note}/duplicate`, { json: {}, project: (r) => ({ status: r.status, title: r.body?.title }) });

  // 簡報資料與 PDF 標註（屬性路徑）
  await call("簡報：寫入 slides_data", "PUT", `/api/nodes/${note}/attributes/slides_data`, { json: { value: JSON.stringify({ theme: "paper", layouts: { 0: "title" } }), value_type: "text" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await get("簡報：讀回 slides_data", `/api/nodes/${note}/attributes?keys=slides_data`, { project: (r) => ({ n: (Array.isArray(r.body) ? r.body : []).length, value: (Array.isArray(r.body) ? r.body : [])[0]?.value }) });
  await call("簡報：slides_data 不是 JSON", "PUT", `/api/nodes/${other}/attributes/slides_data`, { json: { value: "不是JSON", value_type: "text" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("PDF：舊的 pdf_annotations 屬性已唯讀", "PUT", `/api/nodes/${note}/attributes/pdf_annotations`, { json: { value: "[]", value_type: "text" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
}

export async function searchArea(api) {
  const { call } = api;
  const mk = (title, markdown, tags) => makeNote(api, `搜尋：建立 ${title}`, `search:${title}`, { title, markdown });
  const tag = nameIf(api, "tag:search", (await call("搜尋：建立標籤 搜尋標籤", "POST", "/api/tags", { json: { name: "搜尋標籤" }, project: (r) => ({ status: r.status }) })).body?.id);
  const a = await mk("濃縮咖啡筆記", "今天喝了一杯 espresso，濃縮咖啡的香氣很好。\n\nCold brew 要泡十二小時。");
  const b = await mk("手沖咖啡", "手沖咖啡使用 V60 濾杯，粉水比 1:15。");
  const c = await mk("茶葉清單", "烏龍茶與紅茶，沒有咖啡因。tea collection");
  await mk("English only note", "The quick brown fox jumps over the lazy dog. Espresso machine maintenance.");
  await call("搜尋：A 套用標籤", "PUT", `/api/nodes/${a}/tags/${tag}`, { project: (r) => ({ status: r.status }) });
  await call("搜尋：C 套用標籤", "PUT", `/api/nodes/${c}/tags/${tag}`, { project: (r) => ({ status: r.status }) });
  void b;
  // 真 Postgres（pgroonga）與 PGlite 的排序不同：只比「結果集合」，不比順序（已知差異見 docs/agents/testing.md）
  const set = (r) => (Array.isArray(r.body) ? { status: r.status, titles: r.body.filter((x) => api.names.has(x.id)).map((x) => x.title).sort() } : { status: r.status, error: r.body?.error });
  const s = (step, q) => call(step, "GET", `/api/nodes/search?q=${encodeURIComponent(q)}`, { project: set });
  await s("搜尋：中文詞 咖啡", "咖啡");
  await s("搜尋：中文詞 濃縮咖啡", "濃縮咖啡");
  await s("搜尋：中文單字 茶", "茶");
  await s("搜尋：英文詞 espresso", "espresso");
  await s("搜尋：英文大小寫 ESPRESSO", "ESPRESSO");
  await s("搜尋：中英混合 espresso 咖啡", "espresso 咖啡");
  await s("搜尋：詞組 cold brew", "\"cold brew\"");
  await s("搜尋：詞組順序顛倒 brew cold", "\"brew cold\"");
  await s("搜尋：標籤篩選 #搜尋標籤", "#搜尋標籤");
  await s("搜尋：標籤篩選加關鍵字", "#搜尋標籤 咖啡");
  await s("搜尋：不存在的標籤篩選", "#沒有這個標籤");
  await s("搜尋：空結果", "完全不會出現的詞語qwertz");
  await s("搜尋：錯字 espreso", "espreso");
  await s("搜尋：標題與內文都命中 咖啡 筆記", "咖啡 筆記");
  await s("搜尋：兩個英文詞 quick fox", "quick fox");
  await s("搜尋：特殊字元", "咖啡 & (茶)");
  await call("搜尋：空字串", "GET", "/api/nodes/search?q=", { project: set });
}
