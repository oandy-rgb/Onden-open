// 區 1、2：收件匣與待審；寄件匣在後端看得到的行為（離線佇列送到伺服器的樣子）。
import { KEY, idOf, makeNote, nameIf, maskKeys } from "./util.mjs";

/** 事件清單只留看得出「誰做了什麼」的欄位；流水號、時間每個宿主不同。 */
const eventRows = (api) => (r) => {
  const rows = (r.body?.events ?? []).filter((e) => api.names.has(e.target_id) || api.names.has(e.actor_id));
  return rows.map((e) => ({ event_type: e.event_type, actor_name: e.actor_name, target: api.names.get(e.target_id) ?? null, restorable: e.restorable })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
};

export async function inboxArea(api, ctx) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);

  // ── 區 1：快速擷取（照 App：先要收件匣標籤，再帶 tag_ids 建筆記）──────────
  const tag = (await call("收件匣：取得收件匣標籤", "POST", "/api/capture/inbox")).body?.tag_id;
  nameIf(api, "tag:inbox", tag);
  const again = await call("收件匣：再要一次標籤（同一個）", "POST", "/api/capture/inbox");
  void again;
  const cap1 = await makeNote(api, "收件匣：快速擷取第一則", "inbox:一", { title: "擷取：買咖啡豆", markdown: "下午去買", tag_ids: [tag] }, { "Idempotency-Key": KEY(101) });
  await makeNote(api, "收件匣：快速擷取第二則", "inbox:二", { title: "擷取：想到的點子", markdown: "白板可以加便利貼", tag_ids: [tag] }, { "Idempotency-Key": KEY(102) });
  await call("收件匣：第一則重送（同一個冪等鍵）", "POST", "/api/nodes", { json: { title: "擷取：買咖啡豆", markdown: "下午去買", tag_ids: [tag] }, headers: { "Idempotency-Key": KEY(101) } });
  await call("收件匣：用查詢列出收件匣", "POST", "/api/query", { json: { tags: ["收件匣"], sort: "title" }, project: (r) => ({ total: r.body?.total, titles: (r.body?.rows ?? []).map((x) => x.title) }) });
  void cap1;

  // ── 區 1：AI 建議進待審（AI 角色用權杖走 MCP；先給我看＝建議，直接改＝收件匣事件）──────
  const spaces = (await call("讀空間清單（命名用）", "GET", "/api/spaces", { project: () => ({ ok: true }) })).body?.spaces ?? [];
  const personal = nameIf(api, "space:personal", spaces.find((s) => s.kind === "personal")?.id);
  const sharedSpace = nameIf(api, "space:default-shared", spaces.find((s) => s.kind === "shared" && s.is_default)?.id);
  void personal;
  await call("開啟 AI 模組", "PATCH", "/api/workspace/modules", { json: { module: "ai", imported: true }, project: (r) => ({ ai: (r.body?.modules ?? []).includes("ai") }) });
  const agent = nameIf(api, "actor:ai", (await call("建立 AI 角色", "POST", "/api/actors", { json: { name: "助理小幫手", type: "agent" } })).body?.id);
  const tok = await call("替 AI 角色發 MCP 權杖", "POST", `/api/actors/${agent}/tokens`, { json: { name: "對照用權杖", access: "write" }, project: (r) => maskKeys(["token", "id"])(r.body) });
  ctx.aiToken = tok.body?.token;
  nameIf(api, "token:ai", tok.body?.id);
  await call("設定 AI 角色的呼叫名稱", "PUT", `/api/agent-sessions/runners/${agent}`, { json: { handle: "helper" }, project: (r) => ({ handle: r.body?.runner?.handle, enabled: r.body?.runner?.enabled, runtime: r.body?.runner?.default_runtime }) });
  await call("把 AI 角色加進共用空間（可編輯）", "PUT", `/api/spaces/${sharedSpace}/members/${agent}`, { json: { permission: "edit" } });
  const bearer = { authorization: `Bearer ${ctx.aiToken}` };
  ctx.aiHeaders = bearer;
  await call("AI 可用的工具清單", "GET", "/api/mcp/tools", { headers: bearer, project: (r) => ({ tools: (r.body?.tools ?? []).map((t) => t.name).sort() }) });

  const target = await makeNote(api, "建立待審用的筆記", "ai:target", { title: "待審目標", markdown: "原文一行\n第二行", space_id: sharedSpace });
  const mcp = (step, tool, json) => call(step, "POST", `/api/mcp/tools/${tool}`, { json, headers: bearer, project: (r) => ({ ok: r.body?.ok, error: r.body?.error, title: r.body?.result?.title, markdown: r.body?.result?.markdown, suggestion: r.body?.result?.suggestion_id ? true : undefined, result_keys: Object.keys(r.body?.result ?? {}).filter((k) => !/id$|at$|slug/.test(k)).sort() }) });

  // 預設「先給我看」：AI 改內文變成待審建議，不直接動筆記
  await mcp("AI（先給我看）改內文＝提建議", "updateNode", { id: target, markdown: "AI 建議的一行\n第二行", base_markdown: "原文一行\n第二行" });
  await mcp("AI（先給我看）直接建立筆記被擋", "createNode", { title: "AI 想直接建", markdown: "x", space_id: sharedSpace });
  await get("讀待審目標（還沒被改）", `/api/nodes/${target}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  const sugg = await get("待審建議清單", `/api/ai-suggestions?node_id=${target}`, { project: (r) => ({ can_decide: r.body?.can_decide, count: r.body?.suggestions?.length, items: (r.body?.suggestions ?? []).flatMap((s) => s.items.map((i) => [i.status, i.kind, i.new_text])) }) });
  const suggestion = sugg.body?.suggestions?.[0]?.id;
  nameIf(api, "suggestion:1", suggestion);
  if (suggestion) {
    await call("接受 AI 的建議", "POST", `/api/ai-suggestions/${suggestion}/accept`, { json: { item_ids: "all" }, project: (r) => maskKeys(["event_id", "id"])(r.body) });
    await get("接受後的內文", `/api/nodes/${target}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  }
  await mcp("AI（先給我看）再提一個建議", "updateNode", { id: target, markdown: "AI 另一個建議\n第二行", base_markdown: "AI 建議的一行\n第二行" });
  const sugg2 = (await get("第二個待審建議", `/api/ai-suggestions?node_id=${target}`, { project: (r) => ({ count: r.body?.suggestions?.length, items: (r.body?.suggestions ?? []).flatMap((s) => s.items.map((i) => [i.status, i.new_text])) }) })).body?.suggestions?.find((s) => s.items.some((i) => i.status === "pending"));
  if (sugg2?.id) {
    nameIf(api, "suggestion:2", sugg2.id);
    await call("拒絕 AI 的建議", "POST", `/api/ai-suggestions/${sugg2.id}/reject`, { json: { item_ids: "all" }, project: (r) => maskKeys(["event_id", "id"])(r.body) });
    await get("拒絕後的內文（不變）", `/api/nodes/${target}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  }

  // 改成「直接改」：事件進收件匣，接受一筆、拒絕一筆（拒絕＝還原那次修改）
  await call("AI 角色改成直接改", "PATCH", `/api/ai/roles/${agent}`, { json: { review_rule: "apply" }, project: (r) => ({ review_rule: r.body?.role?.review_rule }) });
  const created = await mcp("AI（直接改）建立筆記", "createNode", { title: "AI 建的筆記", markdown: "AI 寫的內容", space_id: sharedSpace });
  void created;
  await mcp("AI（直接改）改內文", "updateNode", { id: target, markdown: "AI 直接改的\n第二行", base_markdown: "AI 建議的一行\n第二行" });
  const inbox = await get("收件匣的待審事件", "/api/inbox", { project: (r) => ({ count: r.body?.count, facets: { by_type: (r.body?.facets?.by_type ?? []).map((f) => [f.event_type, f.count]).sort() }, events: eventRows(api)(r) }) });
  const events = inbox.body?.events ?? [];
  const evUpdate = events.find((e) => e.event_type === "NODE_UPDATED");
  const evCreate = events.find((e) => e.event_type === "NODE_CREATED");
  if (evCreate) await call("接受一筆（AI 建的筆記）", "POST", `/api/inbox/${evCreate.id}/approve`, { project: (r) => ({ decision: r.body?.decision, error: r.body?.error }) });
  if (evUpdate) await call("拒絕一筆（AI 直接改的內文）", "POST", `/api/inbox/${evUpdate.id}/reject`, { project: (r) => ({ decision: r.body?.decision, error: r.body?.error, restored: !!r.body?.restore }) });
  await get("拒絕後的內文（還原成改之前）", `/api/nodes/${target}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  await get("再列一次收件匣", "/api/inbox", { project: (r) => ({ count: r.body?.count, events: eventRows(api)(r) }) });
  await call("收件匣：重複接受同一筆", "POST", `/api/inbox/${evCreate?.id ?? 999999}/approve`, { project: (r) => ({ error: r.body?.error }) });
  await get("等待核准的外部動作", "/api/inbox/approvals", { project: (r) => ({ count: r.body?.count }) });
  await get("失敗的外部動作", "/api/inbox/failed-effects", { project: (r) => ({ keys: Object.keys(r.body ?? {}).sort() }) });

  // ── 區 2：寄件匣（前端離線佇列送到伺服器時的樣子）───────────────────────
  // 同一個冪等鍵送兩次只生效一次
  const dup = await makeNote(api, "寄件匣：建立（冪等鍵 1）", "outbox:dup", { title: "寄件匣重送", markdown: "一次" }, { "Idempotency-Key": KEY(201) });
  await call("寄件匣：同一個冪等鍵重送", "POST", "/api/nodes", { json: { title: "寄件匣重送", markdown: "一次" }, headers: { "Idempotency-Key": KEY(201) } });
  await call("寄件匣：重送後只有一篇", "GET", `/api/nodes/search?q=${encodeURIComponent("寄件匣重送")}`, { project: (r) => ({ n: (r.body ?? []).filter((x) => x.title === "寄件匣重送").length }) });
  await call("寄件匣：改內文（冪等鍵）", "PATCH", `/api/nodes/${dup}`, { json: { markdown: "改一次" }, headers: { "Idempotency-Key": KEY(202) } });
  await call("寄件匣：改內文重送（同一個鍵）", "PATCH", `/api/nodes/${dup}`, { json: { markdown: "改一次" }, headers: { "Idempotency-Key": KEY(202) } });
  await call("寄件匣：不是 UUID 的冪等鍵", "PATCH", `/api/nodes/${dup}`, { json: { markdown: "x" }, headers: { "Idempotency-Key": "not-a-uuid" } });

  // 帶舊的 base 改內文：不重疊的行合併，重疊的行有衝突
  const m = await makeNote(api, "寄件匣：建立三行的筆記", "outbox:merge", { title: "合併測試", markdown: "第一行\n第二行\n第三行" });
  const base = "第一行\n第二行\n第三行";
  await call("寄件匣：裝置一改第一行", "PATCH", `/api/nodes/${m}`, { json: { markdown: "第一行（裝置一）\n第二行\n第三行", base_markdown: base } });
  await call("寄件匣：裝置二用舊 base 改第三行（不重疊，合併）", "PATCH", `/api/nodes/${m}`, { json: { markdown: "第一行\n第二行\n第三行（裝置二）", base_markdown: base } });
  await get("寄件匣：合併後的內文", `/api/nodes/${m}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  await call("寄件匣：裝置三用舊 base 改第一行（重疊，衝突）", "PATCH", `/api/nodes/${m}`, { json: { markdown: "第一行（裝置三）\n第二行\n第三行", base_markdown: base } });
  await get("寄件匣：衝突後的內文", `/api/nodes/${m}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  await call("寄件匣：base 與現況相同（正常覆寫）", "PATCH", `/api/nodes/${m}`, { json: { markdown: "整篇重寫", base_markdown: (await call("讀合併筆記現況", "GET", `/api/nodes/${m}`, { project: () => ({}) })).body?.markdown } });

  // 離線期間排了好幾筆：建立→改→移動→刪除，依序送出；整串再送一次全是重複
  const off = KEY(300);
  const parent = await makeNote(api, "寄件匣：離線前先有的父筆記", "outbox:parent", { title: "離線父筆記", markdown: "父" });
  const queue = [
    ["寄件匣：離線佇列 1 建立", "POST", "/api/nodes", { id: off, title: "離線建立", markdown: "v1" }, KEY(301)],
    ["寄件匣：離線佇列 2 改內文", "PATCH", `/api/nodes/${off}`, { markdown: "v2", base_markdown: "v1" }, KEY(302)],
    ["寄件匣：離線佇列 3 移動到父筆記底下", "PATCH", `/api/nodes/${off}`, { parent_id: parent }, KEY(303)],
    ["寄件匣：離線佇列 4 刪除", "DELETE", `/api/nodes/${off}`, undefined, KEY(304)],
  ];
  nameIf(api, "outbox:offline", off);
  for (const [step, method, path, json, key] of queue) await call(step, method, path, { json, headers: { "Idempotency-Key": key } });
  await get("寄件匣：佇列送完後的筆記（已刪除）", `/api/nodes/${off}`, { project: (r) => ({ status: r.status, error: r.body?.error }) });
  for (const [step, method, path, json, key] of queue) await call(`${step}（整串重送）`, method, path, { json, headers: { "Idempotency-Key": key }, project: (r) => ({ deduped: r.body?.deduped ?? false, status: r.status }) });
  await get("寄件匣：整串重送後仍是已刪除", `/api/nodes/${off}`, { project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("寄件匣：父筆記沒有被動到", "GET", `/api/nodes/${parent}`, { project: (r) => ({ title: r.body?.title, markdown: r.body?.markdown, deleted: r.body?.deleted_at != null }) });
  void idOf;
}
