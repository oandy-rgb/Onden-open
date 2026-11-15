// 區 3、4、5：同步（/api/sync）、查詢與檢視（/api/query、存成檢視）、日記與行程（/api/day、任務議程）。
import { idOf, makeNote, nameIf, KEY } from "./util.mjs";

const titlesOf = (api, rows) => (rows ?? []).filter((n) => api.names.has(n.id)).map((n) => n.title).sort();
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function syncArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const a = await makeNote(api, "同步：建立甲", "sync:甲", { title: "同步甲", markdown: "甲的內文 syncword" });
  const b = await makeNote(api, "同步：建立乙", "sync:乙", { title: "同步乙", markdown: "乙的內文" });
  const c = await makeNote(api, "同步：建立丙", "sync:丙", { title: "同步丙", markdown: "丙的內文" });
  let cursor0 = 0;
  const boot = await get("同步：開機回應（從頭拉）", "/api/sync?since=0", {
    project: (r) => { cursor0 = Number(r.body?.last_event_id); return { keys: Object.keys(r.body ?? {}).sort(), titles: titlesOf(api, r.body?.nodes?.upsert), deleted: (r.body?.nodes?.delete ?? []).filter((id) => api.names.has(id)).length, head_matches: r.body?.head_event_id === r.body?.last_event_id, cursor_positive: cursor0 > 0 }; },
  });
  const cursor1 = Number(boot.body?.last_event_id);

  await call("同步：改甲的內文", "PATCH", `/api/nodes/${a}`, { json: { markdown: "甲改過 syncword2" } });
  await call("同步：刪除乙", "DELETE", `/api/nodes/${b}`);
  const d = await makeNote(api, "同步：建立丁", "sync:丁", { title: "同步丁", markdown: "丁" });
  await call("同步：丙設自由屬性", "PUT", `/api/nodes/${c}/attributes/mood`, { json: { value: "ok" } });
  let cursor2 = cursor1;
  await get("同步：用上次的游標拉增量", `/api/sync?since=${cursor1}`, {
    project: (r) => {
      cursor2 = Number(r.body?.last_event_id);
      const attrs = (r.body?.attributes?.upsert ?? []).filter((x) => api.names.has(x.node_id)).map((x) => [api.names.get(x.node_id), x.key, x.value]);
      return { advanced: cursor2 > cursor1, titles: titlesOf(api, r.body?.nodes?.upsert), deleted: (r.body?.nodes?.delete ?? []).filter((id) => api.names.has(id)).map((id) => api.names.get(id)), attrs, markdowns: (r.body?.nodes?.upsert ?? []).filter((n) => api.names.has(n.id)).map((n) => [n.title, n.markdown]).sort() };
    },
  });
  await get("同步：沒有新變更時的增量", `/api/sync?since=${cursor2}`, {
    project: (r) => ({ same_cursor: Number(r.body?.last_event_id) === cursor2, upserts: titlesOf(api, r.body?.nodes?.upsert), tasks: r.body?.tasks?.upsert?.length ?? 0 }),
  });
  await call("同步：POST 帶已持有的 id（成員差異）", "POST", "/api/sync", {
    json: { since: cursor2, known: [a, b, c, d] },
    project: (r) => ({ keys: Object.keys(r.body ?? {}).sort(), deleted: (r.body?.nodes?.delete ?? []).filter((id) => api.names.has(id)).map((id) => api.names.get(id)) }),
  });
  await get("同步：可讀 id 的摘要", "/api/sync/membership/digest", { project: (r) => ({ keys: Object.keys(r.body ?? {}).sort() }) });
  await get("同步：可讀 id 分頁", "/api/sync/membership?limit=1000", {
    project: (r) => ({ keys: Object.keys(r.body ?? {}).sort(), has_mine: (r.body?.ids ?? []).filter((id) => api.names.has(id)).map((id) => api.names.get(id)).sort() }),
  });
  await call("同步：批次取內文", "POST", "/api/sync/bodies", { json: { ids: [a, c] }, project: (r) => ({ keys: Object.keys(r.body ?? {}).sort(), bodies: JSON.stringify(r.body).includes("syncword2") }) });
  await call("同步：批次取筆記", "POST", "/api/sync/nodes", { json: { ids: [a, c] }, project: (r) => ({ keys: Object.keys(r.body ?? {}).sort(), titles: titlesOf(api, r.body?.nodes ?? r.body?.upsert ?? (Array.isArray(r.body) ? r.body : [])) }) });
  await get("同步：手寫索引", "/api/sync/drawings", { project: (r) => ({ keys: Object.keys(r.body ?? {}).sort() }) });
  await get("同步：游標不是數字", "/api/sync?since=abc", { project: (r) => ({ ok: r.status, titles: titlesOf(api, r.body?.nodes?.upsert).length > 0 }) });
  void KEY; void idOf;
}

export async function queryArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const tag = nameIf(api, "tag:query", (await call("查詢：建立標籤 查詢對照", "POST", "/api/tags", { json: { name: "查詢對照" } })).body?.id);
  await call("查詢：標籤欄位 score、kind", "PATCH", `/api/tags/${tag}/schema`, { json: { fields: [{ name: "score", type: "number" }, { name: "kind", type: "select", options: ["書", "論文", "網頁"] }] } });
  const rows = [["Q-甲", 3, "書"], ["Q-乙", 9, "論文"], ["Q-丙", 6, "論文"], ["Q-丁", null, null]];
  const ids = {};
  for (const [title, score, kind] of rows) {
    const id = await makeNote(api, `查詢：建立 ${title}`, `q:${title}`, { title, markdown: `${title} 的內文 queryword` });
    ids[title] = id;
    await call(`查詢：${title} 套用標籤`, "PUT", `/api/nodes/${id}/tags/${tag}`);
    if (score !== null) await call(`查詢：${title} 設 score`, "PUT", `/api/nodes/${id}/attributes/score`, { json: { value: score } });
    if (kind) await call(`查詢：${title} 設 kind`, "PUT", `/api/nodes/${id}/attributes/kind`, { json: { value: kind } });
  }
  // 標題排序依資料庫的排序規則（真 Postgres 與 PGlite 不一定同序），所以只比集合；數字欄位的排序才比順序。
  const q = (step, body, asSet = body.sort === "title" || !body.sort) => call(step, "POST", "/api/query", { json: body, project: (r) => (r.status >= 400 ? { error: r.body?.error } : { total: r.body?.total, next: r.body?.next, titles: (r.body?.rows ?? []).map((x) => x.title).sort((a, b) => (asSet ? (a < b ? -1 : 1) : 0)), keys: Object.keys(r.body?.rows?.[0] ?? {}).sort() }) });
  await q("查詢：只用標籤", { tags: ["查詢對照"] }, true);
  await q("查詢：score 由高到低", { tags: ["查詢對照"], sort: "-score" });
  await q("查詢：score 大於等於 6", { tags: ["查詢對照"], where: { score: { op: "gte", value: "6" } }, sort: "-score" });
  await q("查詢：score 小於 6", { tags: ["查詢對照"], where: { score: { op: "lt", value: "6" } }, sort: "title" });
  await q("查詢：kind 等於 論文（簡寫）", { tags: ["查詢對照"], where: { kind: "論文" }, sort: "title" });
  await q("查詢：標題包含 乙", { tags: ["查詢對照"], where: { title: { op: "contains", value: "乙" } } });
  await q("查詢：kind 沒有值", { tags: ["查詢對照"], where: { kind: { op: "empty" } } });
  await q("查詢：score 有值", { tags: ["查詢對照"], where: { score: { op: "nempty" } }, sort: "title" });
  await q("查詢：兩個條件一起", { tags: ["查詢對照"], where: { kind: "論文", score: { op: "gt", value: "7" } } });
  await q("查詢：分頁第一頁", { tags: ["查詢對照"], sort: "-score", limit: 2 });
  await q("查詢：分頁第二頁", { tags: ["查詢對照"], sort: "-score", limit: 2, offset: 2 });
  await q("查詢：沒有符合的", { tags: ["查詢對照"], where: { score: { op: "gt", value: "100" } } });
  await q("查詢：不存在的標籤", { tags: ["沒有這個標籤"] });
  await q("查詢：不認得的欄位名稱（拒絕）", { tag: "查詢對照" });
  await q("查詢：不認得的運算（拒絕）", { tags: ["查詢對照"], where: { score: { op: "like", value: "1" } } });

  // 存成檢視 → 讀回 → 執行 → 改 → 刪
  const mkView = await call("檢視：存成標籤檢視", "POST", `/api/tags/${tag}/views`, {
    json: { name: "高分論文", layout: "table", filters: [{ field: "score", op: "gte", value: "6" }], sorts: [{ field: "score", dir: "desc" }], visible_fields: ["score", "kind"], layout_config: {} },
    project: (r) => ({ status: r.status, has_id: !!r.body?.id }),
  });
  const viewId = nameIf(api, "view:高分", mkView.body?.id);
  await call("檢視：同名檢視（衝突）", "POST", `/api/tags/${tag}/views`, { json: { name: "高分論文", layout: "table" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await get("檢視：讀回標籤的檢視", `/api/tags/${tag}/views`, { project: (r) => ({ views: (r.body?.views ?? r.body ?? []).map((v) => ({ name: v.name, layout: v.layout, filters: v.filters, sorts: v.sorts, visible_fields: v.visible_fields })) }) });
  await get("檢視：執行", `/api/tags/${tag}/views/${viewId}/exec`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort(), titles: (r.body?.rows ?? r.body?.nodes ?? []).map((x) => x.title ?? x.node?.title) }) });
  await call("檢視：改成只看論文", "PATCH", `/api/tags/${tag}/views/${viewId}`, { json: { name: "論文", filters: [{ field: "kind", op: "eq", value: "論文" }] } });
  await get("檢視：改後再執行", `/api/tags/${tag}/views/${viewId}/exec`, { project: (r) => ({ titles: (r.body?.rows ?? r.body?.nodes ?? []).map((x) => x.title ?? x.node?.title).sort() }) });
  const noteView = nameIf(api, "view:筆記上", (await call("檢視：存在一篇筆記上", "POST", `/api/nodes/${ids["Q-甲"]}/views`, { json: { name: "筆記檢視", layout: "table", filters: [], sorts: [], visible_fields: [] }, project: (r) => ({ status: r.status }) })).body?.id);
  await get("檢視：筆記上的檢視清單", `/api/nodes/${ids["Q-甲"]}/views`, { project: (r) => ({ names: (r.body?.views ?? []).map((v) => v.name) }) });
  await call("檢視：刪除筆記上的檢視", "DELETE", `/api/nodes/${ids["Q-甲"]}/views/${noteView}`);
  await call("檢視：刪除標籤檢視", "DELETE", `/api/tags/${tag}/views/${viewId}`);
  await get("檢視：刪除後執行（找不到）", `/api/tags/${tag}/views/${viewId}/exec`, { project: (r) => ({ status: r.status }) });
}

export async function dayArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const now = Date.now();
  const today = isoDay(now);
  const rel = (d) => (typeof d === "string" ? Math.round((Date.parse(d) - Date.parse(today)) / DAY) : d);
  const t = (title, extra = {}) => call(`行程：建立任務 ${title}`, "POST", "/api/tasks", { json: { title, ...extra }, project: (r) => ({ status: r.status, when: rel(r.body?.when_date), recur: r.body?.recur }) });
  const mk = async (title, extra) => nameIf(api, `task:${title}`, (await t(title, extra)).body?.id);
  const overdue = await mk("逾期的", { when_date: isoDay(now - 2 * DAY) });
  const todayT = await mk("今天的", { when_date: today });
  const soon = await mk("三天後", { when_date: isoDay(now + 3 * DAY) });
  const later = await mk("很久以後", { when_date: isoDay(now + 60 * DAY) });
  const daily = await mk("每天一次", { when_date: today, recur: "1d" });
  const weekly = await mk("每週一次", { when_date: isoDay(now - 3 * DAY), recur: "1w" });
  const inbox = await mk("沒日期的", {});
  const dl = await mk("有截止日", { deadline: isoDay(now + 1 * DAY) });
  void inbox; void dl;
  const TITLES = new Set(["逾期的", "今天的", "三天後", "很久以後", "每天一次", "每週一次", "沒日期的", "有截止日"]);
  const agenda = (step) => get(step, "/api/tasks/agenda", {
    project: (r) => {
      const out = {};
      // 重複任務勾選後排的「下一次」是新的任務（新 id），所以用標題認：劇本建的任務標題都在 TITLES 裡。
      for (const [bucket, list] of Object.entries(r.body?.buckets ?? {})) out[bucket] = list.filter((x) => TITLES.has(x.title)).map((x) => [x.title, x.status, rel(x.when_date), rel(x.deadline)]).sort();
      out.done = (r.body?.done ?? []).filter((x) => TITLES.has(x.title)).map((x) => [x.title, x.status, rel(x.when_date)]).sort();
      return out;
    },
  });
  await agenda("行程：議程（今天、逾期、即將）");
  await call("行程：勾選今天的", "PATCH", `/api/tasks/${todayT}`, { json: { status: "done" }, project: (r) => ({ status: r.body?.status }) });
  await call("行程：勾選每天重複的（排下一次）", "PATCH", `/api/tasks/${daily}`, { json: { status: "done" }, project: (r) => ({ status: r.body?.status, when: rel(r.body?.when_date) }) });
  await call("行程：勾選每週重複且逾期的", "PATCH", `/api/tasks/${weekly}`, { json: { status: "done" }, project: (r) => ({ status: r.body?.status, when: rel(r.body?.when_date) }) });
  await call("行程：逾期的改到明天", "PATCH", `/api/tasks/${overdue}`, { json: { when_date: isoDay(now + DAY) }, project: (r) => ({ when: rel(r.body?.when_date) }) });
  await call("行程：很久以後的改成沒日期", "PATCH", `/api/tasks/${later}`, { json: { when_date: null }, project: (r) => ({ when: rel(r.body?.when_date) }) });
  await call("行程：勾選三天後的再取消勾選", "PATCH", `/api/tasks/${soon}`, { json: { status: "done" }, project: (r) => ({ status: r.body?.status }) });
  await call("行程：取消勾選", "PATCH", `/api/tasks/${soon}`, { json: { status: "todo" }, project: (r) => ({ status: r.body?.status }) });
  await agenda("行程：勾選與改日期後的議程");

  const dayNote = nameIf(api, "day:note", (await call("日記：建立今天的日記", "POST", "/api/nodes", { json: { title: today, markdown: "今天寫的 diaryword" }, project: (r) => ({ status: r.status, title: r.body?.title === today }) })).body?.id);
  void dayNote;
  const lens = (step, date) => get(step, `/api/day/${date}/lens`, {
    project: (r) => r.status >= 400 ? { status: r.status, error: r.body?.error } : { date: r.body?.date === date, buckets: Object.fromEntries(Object.entries(r.body?.buckets ?? {}).map(([k, v]) => [k, (v.items ?? []).filter((x) => api.names.has(x.id)).map((x) => x.title).sort()])) },
  });
  await lens("日記：今天的視角", today);
  await lens("日記：昨天的視角", isoDay(now - DAY));
  await lens("日記：三天後的視角（有任務）", isoDay(now + 3 * DAY));
  await lens("日記：不是日曆日（2 月 31 日）", "2026-02-31");
  await lens("日記：格式不對", "yesterday");
  await get("日記：今天被編輯的筆記", `/api/history/day?date=${today}`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  await get("日記：今天被編輯的筆記清單", `/api/history/day/notes?date=${today}`, { project: (r) => ({ titles: (r.body?.notes ?? []).filter((n) => api.names.has(n.id)).map((n) => n.title).sort().slice(0, 8), has: (r.body?.notes ?? []).some((n) => api.names.has(n.id)) }) });
  await get("日記：近七天活動", "/api/history/activity?days=7", { project: (r) => ({ days: r.body?.days?.length, last_has_you: (r.body?.days?.at(-1)?.you ?? 0) > 0 }) });
}
