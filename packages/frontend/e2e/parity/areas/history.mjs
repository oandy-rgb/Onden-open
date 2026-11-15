// 區 6、7：歷史與事件（版本、事件列表、用事件復原、復原被拒）、連結圖（edges、反向連結、改名、指向已刪筆記）。
import { makeNote, nameIf } from "./util.mjs";

/** 這個宿主上，某個對象的事件（新到舊）；只留看得出發生什麼的欄位。 */
const eventRows = (api) => (r) => (r.body?.events ?? []).map((e) => [e.event_type, e.actor_type, e.restorable, e.restore_blocked_reason ?? null]);

export async function historyArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const events = async (id, deleted = false) => (await call(`讀事件（內部取 id）`, "GET", `/api/events?target_id=${id}&limit=50${deleted ? "&deleted=true" : ""}`, { project: () => ({}) })).body?.events ?? [];

  // ── 版本與歷史 ─────────────────────────────────────────────────────────
  const h = await makeNote(api, "歷史：建立 H", "hist:H", { title: "歷史對照", markdown: "版本一" });
  await call("歷史：H 改成版本二", "PATCH", `/api/nodes/${h}`, { json: { markdown: "版本二" } });
  await call("歷史：H 改成版本三並改標題", "PATCH", `/api/nodes/${h}`, { json: { title: "歷史對照 三", markdown: "版本三" } });
  await get("歷史：H 的版本列表", `/api/nodes/${h}/versions`, { project: api.projectVersions });
  await get("歷史：H 的歷史", `/api/nodes/${h}/history`, { project: api.projectVersions });
  await get("歷史：全工作區動態", "/api/history/feed?days=3", { project: (r) => ({ status: r.status, days: (r.body?.days ?? []).length > 0, has_mine: JSON.stringify(r.body).includes("歷史對照") }) });

  // ── 事件列表 ───────────────────────────────────────────────────────────
  await get("事件：H 的事件", `/api/events?target_id=${h}&limit=50`, { project: eventRows(api) });
  await get("事件：只看建立事件", `/api/events?target_id=${h}&event_type=NODE_CREATED`, { project: eventRows(api) });
  await get("事件：只看 1 筆", `/api/events?target_id=${h}&limit=1`, { project: (r) => ({ count: r.body?.count }) });
  await get("事件：limit 不合法（拒絕）", "/api/events?limit=abc", { project: (r) => ({ status: r.status }) });
  await get("事件：不認得的對象 id", "/api/events?target_id=not-a-uuid", { project: (r) => ({ status: r.status, count: r.body?.count }) });

  // ── 用事件復原：最新一次修改 ───────────────────────────────────────────
  let evs = await events(h);
  const latest = evs.find((e) => e.event_type === "NODE_UPDATED");
  if (latest) {
    await get("復原：預覽最新一次修改", `/api/events/${latest.id}/preview`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort(), error: r.body?.error }) });
    await call("復原：復原最新一次修改（版本三→二）", "POST", `/api/events/${latest.id}/restore`, { json: {}, project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).filter((k) => !/id$/.test(k)).sort() }) });
    await get("復原：復原後的 H", `/api/nodes/${h}`, { project: (r) => ({ title: r.body?.title, markdown: r.body?.markdown }) });
    await call("復原：同一個事件再復原一次", "POST", `/api/events/${latest.id}/restore`, { json: {}, project: (r) => ({ status: r.status, error: r.body?.error }) });
    await get("復原：復原留下新的事件，舊的還在", `/api/events?target_id=${h}&limit=50`, { project: eventRows(api) });
  }

  // ── 不重疊的行：可復原；重疊的行：被拒 ───────────────────────────────────
  const m = await makeNote(api, "復原：建立三行的筆記", "hist:M", { title: "復原三行", markdown: "甲\n乙\n丙" });
  await call("復原：改第一行", "PATCH", `/api/nodes/${m}`, { json: { markdown: "甲改\n乙\n丙", base_markdown: "甲\n乙\n丙" } });
  await call("復原：改第三行", "PATCH", `/api/nodes/${m}`, { json: { markdown: "甲改\n乙\n丙改", base_markdown: "甲改\n乙\n丙" } });
  const mevs = (await events(m)).filter((e) => e.event_type === "NODE_UPDATED");
  const first = mevs[mevs.length - 1];
  if (first) {
    await call("復原：復原較早的第一行修改（後面改的是別行）", "POST", `/api/events/${first.id}/restore`, { json: {}, project: (r) => ({ status: r.status, error: r.body?.error }) });
    await get("復原：只還原第一行，第三行的後續編輯保留", `/api/nodes/${m}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  }
  const c = await makeNote(api, "復原：建立單行筆記", "hist:C", { title: "復原衝突", markdown: "原本" });
  await call("復原：改成中間版", "PATCH", `/api/nodes/${c}`, { json: { markdown: "中間" } });
  await call("復原：再改成最終版", "PATCH", `/api/nodes/${c}`, { json: { markdown: "最終" } });
  const cevs = (await events(c)).filter((e) => e.event_type === "NODE_UPDATED");
  const mid = cevs[cevs.length - 1];
  if (mid) {
    await call("復原被拒：後續編輯衝突", "POST", `/api/events/${mid.id}/restore`, { json: {}, project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).sort() }) });
    await get("復原被拒：現況保留", `/api/nodes/${c}`, { project: (r) => ({ markdown: r.body?.markdown }) });
    await get("復原被拒：預覽也說明原因", `/api/events/${mid.id}/preview`, { project: (r) => ({ status: r.status, error: r.body?.error }) });
  }
  // 復原刪除
  const d = await makeNote(api, "復原：建立要刪的筆記", "hist:D", { title: "復原刪除", markdown: "會被刪" });
  await call("復原：刪除", "DELETE", `/api/nodes/${d}`);
  const del = (await events(d, true)).find((e) => e.event_type === "NODE_DELETED");
  if (del) {
    await call("復原：用事件復原刪除", "POST", `/api/events/${del.id}/restore`, { json: {}, project: (r) => ({ status: r.status, error: r.body?.error }) });
    await get("復原：筆記回來了", `/api/nodes/${d}`, { project: (r) => ({ status: r.status, title: r.body?.title, deleted: r.body?.deleted_at != null }) });
  }
  await call("復原：不存在的事件", "POST", "/api/events/999999999/restore", { json: {}, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("復原：事件 id 不是數字", "POST", "/api/events/abc/restore", { json: {}, project: (r) => ({ status: r.status }) });

  // ── 垃圾桶 ─────────────────────────────────────────────────────────────
  const t1 = await makeNote(api, "垃圾桶：建立一", "trash:一", { title: "垃圾桶一", markdown: "丟掉一" });
  const t2 = await makeNote(api, "垃圾桶：建立二", "trash:二", { title: "垃圾桶二", markdown: "丟掉二" });
  await call("垃圾桶：刪除一", "DELETE", `/api/nodes/${t1}`);
  await call("垃圾桶：刪除二", "DELETE", `/api/nodes/${t2}`);
  await get("垃圾桶：列表", "/api/history/deleted", { project: (r) => ({ titles: (r.body?.notes ?? []).filter((n) => api.names.has(n.id)).map((n) => n.title).sort() }) });
  await get("垃圾桶：看被刪筆記的內文", `/api/history/deleted/${t1}`, { project: (r) => ({ status: r.status, title: r.body?.title, markdown: r.body?.markdown }) });
  await get("垃圾桶：永久刪除前預覽", `/api/nodes/${t1}/purge-preview`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  await call("垃圾桶：清空單筆（永久刪除一）", "POST", `/api/nodes/${t1}/purge`, { json: { expected_ids: [t1] }, project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).sort() }) });
  await get("垃圾桶：清空後列表只剩二", "/api/history/deleted", { project: (r) => ({ titles: (r.body?.notes ?? []).filter((n) => api.names.has(n.id)).map((n) => n.title).sort() }) });
  await get("垃圾桶：永久刪除的筆記讀不到", `/api/nodes/${t1}`, { project: (r) => ({ status: r.status }) });
  await call("垃圾桶：復原二", "POST", `/api/nodes/${t2}/undelete`, { project: (r) => ({ status: r.status, title: r.body?.title }) });
}

export async function linksArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const src = await makeNote(api, "連結：建立來源", "link:源", { title: "連結來源", markdown: "指向 [[連結目標]] 與 [[連結舊名]] 與 [[連結不存在]]。" });
  const target = await makeNote(api, "連結：建立目標", "link:目標", { title: "連結目標", markdown: "目標內文" });
  const old = await makeNote(api, "連結：建立舊名筆記", "link:舊名", { title: "連結舊名", markdown: "舊名內文" });
  const edges = (step) => get(step, "/api/sync?since=0", {
    project: (r) => ({
      edges: (r.body?.edges?.upsert ?? []).filter((e) => api.names.has(e.source_node_id) && /^link:/.test(api.names.get(e.source_node_id)))
        .map((e) => [api.names.get(e.source_node_id), api.names.get(e.target_node_id) ?? "(未命名)", e.edge_type, e.status, e.origin ?? null]).sort(),
    }),
  });
  await edges("連結：寫入內文後的連結圖");
  await get("連結：來源的內文", `/api/nodes/${src}`, { project: (r) => ({ markdown: r.body?.markdown }) });

  // 手動建立與刪除邊
  const edge = await call("連結：手動建立 related 邊", "POST", "/api/edges", { json: { source_node_id: target, target_node_id: old, edge_type: "related" }, project: (r) => ({ status: r.status, type: r.body?.edge_type, st: r.body?.status }) });
  const edgeId = nameIf(api, "edge:related", edge.body?.id);
  await call("連結：邊的類型不合法（拒絕）", "POST", "/api/edges", { json: { source_node_id: target, target_node_id: old, edge_type: "Bad-Type" }, project: (r) => ({ status: r.status }) });
  await call("連結：指向不存在的筆記（拒絕）", "POST", "/api/edges", { json: { source_node_id: target, target_node_id: "00000000-0000-4000-8000-0000000000aa", edge_type: "related" }, project: (r) => ({ status: r.status }) });
  await edges("連結：手動邊建立後");
  if (edgeId) await call("連結：刪除手動邊", "DELETE", `/api/edges/${edgeId}`, { project: (r) => ({ status: r.status }) });
  await edges("連結：手動邊刪除後");
  await get("連結：邊的類型清單", "/api/edges/manifest", { project: (r) => ({ status: r.status, has_related: JSON.stringify(r.body).includes("related") }) });

  // 改名後連結跟著改
  await call("連結：把舊名筆記改名", "PATCH", `/api/nodes/${old}`, { json: { title: "連結新名" } });
  await get("連結：改名後來源的內文", `/api/nodes/${src}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  await edges("連結：改名後的連結圖");

  // 指向已刪除的筆記
  await call("連結：刪除目標筆記", "DELETE", `/api/nodes/${target}`);
  await edges("連結：目標被刪後的連結圖");
  await get("連結：目標被刪後來源的內文", `/api/nodes/${src}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  await call("連結：復原目標筆記", "POST", `/api/nodes/${target}/undelete`, { project: (r) => ({ status: r.status }) });
  await edges("連結：目標復原後的連結圖");
  await call("連結：把目標改成跟別人同名", "PATCH", `/api/nodes/${target}`, { json: { title: "連結新名" } });
  await edges("連結：同名時連結指向哪一篇");
  await call("連結：把目標改回不重複的名字（之後的匯出與備份不要有同名筆記）", "PATCH", `/api/nodes/${target}`, { json: { title: "連結目標 改名後" }, project: (r) => ({ status: r.status, title: r.body?.title }) });
  await call("連結：移到子樹後以路徑連結", "PATCH", `/api/nodes/${old}`, { json: { parent_id: src } });
  await get("連結：搜尋反向連結的來源", `/api/nodes/search?q=${encodeURIComponent("連結來源")}`, { project: api.projectSearch });
  void idOfUnused;
}
const idOfUnused = null;
