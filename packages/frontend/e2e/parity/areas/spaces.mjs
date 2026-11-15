// 區 8、9：空間與成員（共用空間、成員權限、移動筆記、邀請）；偏好與工作區設定。
import { makeNote, nameIf, maskKeys } from "./util.mjs";

export async function spacesArea(api, ctx) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const space = nameIf(api, "space:team", (await call("空間：建立共用空間", "POST", "/api/spaces", { json: { name: "對照小組" }, project: (r) => ({ status: r.status, name: r.body?.name, kind: r.body?.kind }) })).body?.id);
  await call("空間：預設不開放給 AI 角色", "GET", "/api/spaces", { project: (r) => ({ external_ai: (r.body?.spaces ?? []).filter((s) => s.id === space).map((s) => s.capabilities?.external_ai) }) });
  await call("空間：名稱空白（拒絕）", "POST", "/api/spaces", { json: { name: "  " }, project: (r) => ({ status: r.status }) });
  await call("空間：改名", "PATCH", `/api/spaces/${space}`, { json: { name: "對照小組二" }, project: (r) => ({ status: r.status }) });
  const spaces = (await get("空間：清單", "/api/spaces", { project: (r) => ({ team: (r.body?.spaces ?? []).filter((s) => s.name?.startsWith("對照小組")).map((s) => [s.name, s.kind, s.permission, s.can_manage]), is_owner: r.body?.is_owner }) }));
  void spaces;
  const personal = (await call("空間：取個人空間（命名用）", "GET", "/api/spaces", { project: () => ({}) })).body?.spaces?.find((s) => s.kind === "personal")?.id;
  nameIf(api, "space:personal", personal);

  // 兩個成員：一個只能看、一個可以編輯（都是 AI 角色，用權杖走 MCP 驗證讀寫差異）
  await call("空間：開啟 AI 模組", "PATCH", "/api/workspace/modules", { json: { module: "ai", imported: true }, project: (r) => ({ ai: (r.body?.modules ?? []).includes("ai") }) });
  const viewer = nameIf(api, "actor:viewer", (await call("成員：建立只能看的角色", "POST", "/api/actors", { json: { name: "旁觀者", type: "agent" }, project: (r) => ({ status: r.status, type: r.body?.type }) })).body?.id);
  const editor = nameIf(api, "actor:editor", (await call("成員：建立可編輯的角色", "POST", "/api/actors", { json: { name: "編輯者", type: "agent" }, project: (r) => ({ status: r.status, type: r.body?.type }) })).body?.id);
  const outsider = nameIf(api, "actor:outsider", (await call("成員：建立不在空間裡的角色", "POST", "/api/actors", { json: { name: "局外人", type: "agent" }, project: (r) => ({ status: r.status }) })).body?.id);
  const tokens = {};
  for (const [label, id] of [["viewer", viewer], ["editor", editor], ["outsider", outsider]]) {
    const r = await call(`成員：${label} 發權杖`, "POST", `/api/actors/${id}/tokens`, { json: { name: `${label} 權杖`, access: "write" }, project: (x) => maskKeys(["token", "id"])(x.body) });
    tokens[label] = { authorization: `Bearer ${r.body?.token}` };
    nameIf(api, `token:${label}`, r.body?.id);
  }
  await call("空間：開放給 AI 角色（external_ai）", "PATCH", `/api/spaces/${space}`, { json: { capabilities: { external_ai: true } }, project: (r) => ({ status: r.status }) });
  await call("成員：加入只能看", "PUT", `/api/spaces/${space}/members/${viewer}`, { json: { permission: "view" }, project: (r) => ({ status: r.status }) });
  await call("成員：加入可編輯", "PUT", `/api/spaces/${space}/members/${editor}`, { json: { permission: "edit" }, project: (r) => ({ status: r.status }) });
  await call("成員：權限值不合法（拒絕）", "PUT", `/api/spaces/${space}/members/${outsider}`, { json: { permission: "owner" }, project: (r) => ({ status: r.status }) });
  await get("成員：列表", `/api/spaces/${space}/members`, { project: (r) => ({ members: (r.body?.members ?? []).map((m) => [m.name, m.type, m.permission]).sort() }) });
  await get("成員：可以加入的人", `/api/spaces/${space}/candidates`, { project: (r) => ({ people: (r.body?.people ?? []).map((p) => p.name).sort() }) });
  await call("成員：個人空間不能加人（拒絕）", "PUT", `/api/spaces/${personal}/members/${viewer}`, { json: { permission: "view" }, project: (r) => ({ status: r.status, error: r.body?.error }) });

  // 把筆記移到共用空間
  const n = await makeNote(api, "空間：建立要搬的筆記", "space:note", { title: "空間搬家", markdown: "共享前的內容 spaceword", space_id: personal });
  const epoch = async () => (await call("空間：讀目前的權限版本", "GET", "/api/sync/membership/digest", { project: () => ({}) })).body?.epoch;
  await get("空間：搬家預覽", `/api/spaces/move-preview?node=${n}&to=${space}`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  await call("空間：用過期的權限版本搬家（拒絕）", "POST", "/api/spaces/move", { json: { node_id: n, to_space_id: space, membership_epoch: "1" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("空間：把筆記移到共用空間", "POST", "/api/spaces/move", { json: { node_id: n, to_space_id: space, membership_epoch: String(await epoch()) }, project: (r) => ({ status: r.status, error: r.body?.error, keys: Object.keys(r.body ?? {}).filter((k) => !/id$/.test(k)).sort() }) });
  await get("空間：搬完後筆記的空間", `/api/nodes/${n}`, { project: (r) => ({ space: api.names.get(r.body?.space_id) ?? "(未命名)" }) });

  const mcp = (step, who, tool, json) => call(step, "POST", `/api/mcp/tools/${tool}`, { json, headers: tokens[who], project: (r) => ({ status: r.status, ok: r.body?.ok, error: r.body?.error, title: r.body?.result?.title ?? r.body?.result?.note?.title, detail: r.body?.detail, result: r.body?.ok ? JSON.stringify(r.body.result).slice(0, 80) : undefined, hits: Array.isArray(r.body?.result?.results) ? r.body.result.results.filter((x) => api.names.has(x.id)).length : undefined }) });
  await mcp("成員：只能看的角色讀得到", "viewer", "getNode", { id: n });
  await mcp("成員：可編輯的角色讀得到", "editor", "getNode", { id: n });
  await mcp("成員：局外人讀不到", "outsider", "getNode", { id: n });
  await mcp("成員：只能看的角色改內文（拒絕）", "viewer", "updateNode", { id: n, markdown: "旁觀者想改", base_markdown: "共享前的內容 spaceword" });
  await mcp("成員：可編輯的角色改內文（成為待審建議）", "editor", "updateNode", { id: n, markdown: "編輯者想改", base_markdown: "共享前的內容 spaceword" });
  await mcp("成員：局外人搜尋看不到", "outsider", "searchNodes", { query: "spaceword" });
  await mcp("成員：可編輯的角色搜尋看得到", "editor", "searchNodes", { query: "spaceword" });
  await get("成員：筆記沒有被直接改動", `/api/nodes/${n}`, { project: (r) => ({ markdown: r.body?.markdown }) });
  await call("成員：移出可編輯的角色", "DELETE", `/api/spaces/${space}/members/${editor}`, { project: (r) => ({ status: r.status }) });
  await mcp("成員：移出後讀不到（撤權）", "editor", "getNode", { id: n });
  await call("成員：同一個成員再移出一次", "DELETE", `/api/spaces/${space}/members/${editor}`, { project: (r) => ({ status: r.status, error: r.body?.error }) });

  // 移回個人空間
  await call("空間：把筆記移回個人空間", "POST", "/api/spaces/move", { json: { node_id: n, to_space_id: personal, membership_epoch: String(await epoch()) }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await get("空間：移回後筆記的空間", `/api/nodes/${n}`, { project: (r) => ({ space: api.names.get(r.body?.space_id) ?? "(未命名)" }) });
  await mcp("空間：移回後旁觀者讀不到", "viewer", "getNode", { id: n });
  await get("空間：總覽", "/api/spaces/overview", { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });

  // 邀請：真人成員用一次性邀請連結加入；撤銷＝重發（舊的失效）或移除成員
  const inv = await call("邀請：建立真人成員（產生邀請）", "POST", "/api/actors", { json: { name: "新同學", type: "human", email: "newbie@onden.local" }, project: (r) => ({ status: r.status, type: r.body?.type, invite_pending: r.body?.invite_pending, has_token: typeof r.body?.invite_token === "string", has_path: typeof r.body?.invite_path === "string" }) });
  const human = nameIf(api, "actor:invited", inv.body?.id);
  const oldToken = inv.body?.invite_token;
  const regen = await call("邀請：重發邀請（舊連結失效）", "POST", `/api/actors/${human}/invite`, { project: (r) => ({ status: r.status, has_token: typeof r.body?.invite_token === "string" }) });
  await call("邀請：用舊連結領取（失敗）", "POST", "/api/invites/claim", { json: { token: oldToken ?? "x" }, project: (r) => ({ status: r.status }) });
  void regen;
  await get("邀請：成員清單看得到未加入的邀請", "/api/actors", { project: (r) => ({ invited: (Array.isArray(r.body) ? r.body : r.body?.actors ?? []).filter((a) => api.names.has(a.id)).map((a) => [a.name, a.type, a.invite_pending]).sort() }) });
  await call("邀請：沒有權限的角色不能建立（拒絕）", "POST", "/api/actors", { json: { name: "偷加人", type: "agent" }, headers: tokens.viewer, project: (r) => ({ status: r.status }) });
  await call("邀請：撤銷（移除未加入的成員）", "DELETE", `/api/actors/${human}`, { project: (r) => ({ status: r.status }) });
  await get("邀請：撤銷後清單", "/api/actors", { project: (r) => ({ invited: (Array.isArray(r.body) ? r.body : r.body?.actors ?? []).filter((a) => a.name === "新同學").length }) });
  await call("邀請：領取沒有的邀請", "POST", "/api/invites/claim", { json: { token: "no-such-token" }, project: (r) => ({ status: r.status }) });

  // 權杖：列出、撤銷
  await get("權杖：列出", `/api/actors/${viewer}/tokens`, { project: (r) => ({ n: (Array.isArray(r.body) ? r.body : r.body?.tokens ?? []).length }) });
  const tid = (await call("權杖：讀 id（命名用）", "GET", `/api/actors/${viewer}/tokens`, { project: () => ({}) })).body;
  const tokenId = (Array.isArray(tid) ? tid : tid?.tokens ?? [])[0]?.id;
  if (tokenId) {
    await call("權杖：撤銷", "POST", `/api/actors/${viewer}/tokens/${tokenId}/revoke`, { project: (r) => ({ status: r.status }) });
    await mcp("權杖：撤銷後再用（拒絕）", "viewer", "getNode", { id: n });
  }

  // 刪除共用空間
  await get("空間：刪除預覽", `/api/spaces/${space}/delete-preview`, { project: (r) => ({ status: r.status, keys: Object.keys(r.body ?? {}).sort() }) });
  await call("空間：刪除共用空間", "DELETE", `/api/spaces/${space}`, { json: {}, project: (r) => ({ status: r.status, ok: r.body?.ok }) });
  await get("空間：刪除後清單", "/api/spaces", { project: (r) => ({ team: (r.body?.spaces ?? []).filter((s) => s.name?.startsWith("對照小組")).length }) });
  ctx.personalSpace = personal;
}

export async function settingsArea(api) {
  const { call } = api;
  const get = (step, path, opts) => call(step, "GET", path, opts);
  const nav = { order: ["notes", "tasks", "board"], phone: 2 };
  await get("偏好：尚未設定", "/api/me/prefs/nav", { project: (r) => ({ value: r.body?.value }) });
  await call("偏好：寫入導覽列", "PUT", "/api/me/prefs/nav", { json: { value: nav }, project: (r) => ({ applied: r.body?.applied, value: r.body?.value }) });
  await get("偏好：讀回導覽列", "/api/me/prefs/nav", { project: (r) => ({ value: r.body?.value }) });
  await call("偏好：形狀不對（拒絕）", "PUT", "/api/me/prefs/nav", { json: { value: { order: "x" } }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("偏好：不認得的鍵", "PUT", "/api/me/prefs/nope", { json: { value: 1 }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("偏好：帶編輯時間再寫一次", "PUT", "/api/me/prefs/nav", { json: { value: nav, editAgeMs: 0 }, project: (r) => ({ applied: r.body?.applied }) });
  await call("偏好：較舊的編輯不蓋過新的", "PUT", "/api/me/prefs/nav", { json: { value: { order: ["old"], phone: 1 }, editAgeMs: 3_600_000 }, project: (r) => ({ applied: r.body?.applied, value: r.body?.value }) });
  await call("偏好：另一個偏好 sidebarTags", "PUT", "/api/me/prefs/sidebarTags", { json: { value: { pinned: [], hidden: [] } }, project: (r) => ({ applied: r.body?.applied }) });
  await call("偏好：清除導覽列", "PUT", "/api/me/prefs/nav", { json: { value: null }, project: (r) => ({ applied: r.body?.applied, value: r.body?.value }) });
  await get("偏好：清除後讀回", "/api/me/prefs/nav", { project: (r) => ({ value: r.body?.value }) });

  await get("工作區：時間設定的預設", "/api/workspace/config", { project: (r) => ({ keys: Object.keys(r.body ?? {}).sort() }) });
  await call("工作區：設定時區與一天開始的時間", "PATCH", "/api/workspace/time", { json: { time_zone: "Asia/Taipei", day_start_hour: 4 }, project: (r) => ({ status: r.status, time_zone: r.body?.time_zone, day_start_hour: r.body?.day_start_hour, today_is_date: /^\d{4}-\d{2}-\d{2}$/.test(r.body?.today ?? "") }) });
  await call("工作區：不認得的時區（拒絕）", "PATCH", "/api/workspace/time", { json: { time_zone: "Mars/Olympus" }, project: (r) => ({ status: r.status, error: r.body?.error }) });
  await call("工作區：一天開始的時間超出範圍（拒絕）", "PATCH", "/api/workspace/time", { json: { day_start_hour: 9 }, project: (r) => ({ status: r.status }) });
  await call("工作區：還原成預設時區", "PATCH", "/api/workspace/time", { json: { time_zone: null, day_start_hour: 0 }, project: (r) => ({ status: r.status, day_start_hour: r.body?.day_start_hour }) });
  await call("工作區：寫入網站設定", "PATCH", "/api/workspace/config", { json: { config: { site_title: "對照站台" } }, project: (r) => ({ status: r.status, config: r.body?.config }) });
  await get("工作區：讀回網站設定", "/api/workspace/config", { project: (r) => ({ config: r.body?.config }) });
  await call("工作區：關掉再開啟看板模組", "PATCH", "/api/workspace/modules", { json: { module: "kanban", imported: false }, project: (r) => ({ off: !(r.body?.modules ?? []).includes("kanban") }) });
  await call("工作區：重新開啟看板模組", "PATCH", "/api/workspace/modules", { json: { module: "kanban", imported: true }, project: (r) => ({ on: (r.body?.modules ?? []).includes("kanban") }) });
  await call("工作區：模組名稱不存在（拒絕）", "PATCH", "/api/workspace/modules", { json: { module: "no-such-module", imported: true }, project: (r) => ({ status: r.status }) });
  const home = await makeNote(api, "工作區：建立首頁筆記", "ws:home", { title: "工作區首頁", markdown: "首頁" });
  await call("工作區：設定首頁筆記", "PATCH", "/api/workspace", { json: { home_node_id: home }, project: (r) => ({ status: r.status, home: api.names.get(r.body?.home_node_id) ?? r.body?.home_node_id ?? null }) });
  await call("工作區：取消首頁筆記", "PATCH", "/api/workspace", { json: { home_node_id: null }, project: (r) => ({ status: r.status, home: r.body?.home_node_id ?? null }) });
  await call("工作區：不是 UUID 的首頁（拒絕）", "PATCH", "/api/workspace", { json: { home_node_id: "x" }, project: (r) => ({ status: r.status }) });
}
