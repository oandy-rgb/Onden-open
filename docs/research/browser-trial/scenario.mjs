// 兩個環境（Node 的 smoke.mjs、瀏覽器 worker）共用的情境：登入、bootstrap、建立／修改筆記、搜尋、並行寫入。
export async function runScenario(bridge, log = console.log) {
  const results = [];
  // cookie 由橋（src/bridge.ts）管理：瀏覽器的 Request 建構子會丟掉 cookie 標頭。
  async function call(label, method, path, body, extra = {}) {
    const t = performance.now();
    const res = await bridge.request(path, {
      method,
      headers: { "content-type": "application/json", ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
    const ms = Math.round(performance.now() - t);
    results.push({ label, status: res.status, ms });
    log(`${String(res.status).padEnd(4)} ${String(ms).padStart(5)}ms ${label} ${res.status >= 400 ? JSON.stringify(json).slice(0, 300) : ""}`);
    return { res, json };
  }
  const idem = () => ({ "idempotency-key": crypto.randomUUID() });
  const show = (r) => log("     → " + JSON.stringify(Array.isArray(r.json) ? r.json.map((x) => ({ title: x.title, snippet: x.snippet?.text?.slice(0, 30) })) : r.json));
  await call("health", "GET", "/health");
  const ta = performance.now();
  await bridge.ensureLocalAccount();
  log(`     本機帳號（橋自己登入）${Math.round(performance.now() - ta)}ms，session=${bridge.hasSession}`);
  const bs = await call("bootstrap", "GET", "/api/bootstrap");
  log("     bootstrap keys: " + Object.keys(bs.json).slice(0, 8).join(","));
  const id = crypto.randomUUID();
  await call("create note", "POST", "/api/nodes", { id, title: "資料結構筆記", markdown: "二元搜尋樹與平衡樹的比較，AVL 與紅黑樹" }, idem());
  await call("create note 2", "POST", "/api/nodes", { id: crypto.randomUUID(), title: "作業系統", markdown: "行程排程、死結與記憶體管理 deadlock" }, idem());
  await call("patch note", "PATCH", `/api/nodes/${id}`, { markdown: "二元搜尋樹與平衡樹的比較，AVL 與紅黑樹。補充：B 樹用在資料庫索引。" }, idem());
  await call("get note", "GET", `/api/nodes/${id}`);
  const q = (s) => "/api/nodes/search?q=" + encodeURIComponent(s);
  show(await call("search 搜尋樹", "GET", q("搜尋樹")));
  show(await call("search 死結 (2 字)", "GET", q("死結")));
  show(await call("search 死結 OR 搜尋樹", "GET", q("死結 OR 搜尋樹")));
  show(await call("search 樹 -AVL (排除)", "GET", q("樹 -AVL")));
  const tp = performance.now();
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => bridge.request(`/api/nodes/${id}`, { method: "PATCH", headers: { "content-type": "application/json", ...idem() }, body: JSON.stringify({ title: `資料結構筆記 ${i}` }) })));
  const parallel = { statuses: many.map((r) => r.status), ms: Math.round(performance.now() - tp) };
  log(`20 個並行 PATCH：${parallel.statuses.join(",")} ${parallel.ms}ms`);
  return { results, parallel };
}
