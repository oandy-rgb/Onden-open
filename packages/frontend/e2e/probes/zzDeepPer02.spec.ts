// Feature-audit deepening (2026-10-09, tick 31): PER-02 — read scope across
// every read entry point. P is in an owner-only space; C is P's child (shares
// its space); D is a deleted (retained) child of P; O is an open note in the
// default space. User B (editor) must see O and never P / C / D through any
// entry; the owner sees all.
import { test, request as pwRequest } from "@playwright/test";
import { defaultSpaceId, hideFromOthers, seedLayout, addToDefaultSpace, BASE, H, psql as db } from "../fullstack/helpers";


test("PER-02: read scope across entry points", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const W = `per02w${s}`; // a word present in every body, for search
  const space_id = await defaultSpaceId(req);
  const mk = async (title: string, parent_id?: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: `${title} ${W} [[Per02 O ${s}]]`, ...(parent_id ? { parent_id } : { space_id }) } })).json()) as { id: string };
  const O = await mk(`Per02 O ${s}`); const P = await mk(`Per02 P ${s}`); const C = await mk(`Per02 C ${s}`, P.id); const D = await mk(`Per02 D ${s}`, P.id);
  const lockSpace = await hideFromOthers(req, P.id); // P with C and D
  await req.patch(`/api/nodes/${C.id}`, { ...H, data: { markdown: `Per02 C ${s} ${W} edited` } });
  await req.delete(`/api/nodes/${D.id}`, H);
  const cv = await (await req.post("/api/canvases", { ...H, data: { title: `Per02 cv ${s}` } })).json();
  await seedLayout(req, cv.id, { ...H, data: { data: { nodes: [O, P, C].map((n, i) => ({ nodeId: n.id, x: i * 10, y: 0 })) } } });
  // User B (editor) + an agent token owned by an editor agent.
  const email = `per02-${s}@example.com`, pw = `pw-${s}-x`;
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const b = ctx.request;
  const su = await (await b.post("/api/auth/sign-up/email", { ...H, data: { name: `Per02 ${s}`, email, password: pw } })).json();
  await req.post("/api/actors", { ...H, data: { name: `Per02 ${s}`, type: "human", external_id: su.user.id } });
  const bActor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Per02 ${s}`)!;
  await addToDefaultSpace(req, bActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  await req.post("/api/actors", { ...H, data: { name: `Per02 agent ${s}`, type: "agent" } });
  const agentActor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Per02 agent ${s}`)!;
  const tok = (await (await req.post(`/api/actors/${agentActor.id}/tokens`, { ...H, data: { template: "read-only" } })).json()).token;
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, "content-type": "application/json", authorization: `Bearer ${tok}` } });

  const ids = { O: O.id, P: P.id, C: C.id, D: D.id };
  const seen = (text: string) => Object.entries(ids).filter(([, id]) => text.includes(id) || text.includes(`Per02 ${id === O.id ? "O" : id === P.id ? "P" : id === C.id ? "C" : "D"} ${s}`)).map(([k]) => k).join("") || "-";
  const m: Record<string, Record<string, string>> = {};
  const row = async (name: string, f: (ctx: typeof req) => Promise<string>) => { m[name] = { owner: await f(req).catch((e) => `ERR ${String(e).slice(0, 40)}`), B: await f(b).catch((e) => `ERR ${String(e).slice(0, 40)}`) }; };
  const txt = async (r: Promise<import("@playwright/test").APIResponse>) => { const x = await r; return `${x.status()}:${seen(await x.text())}`; };
  try {
    for (const [k, id] of Object.entries(ids)) await row(`GET node ${k}`, (c) => txt(c.get(`/api/nodes/${id}`)));
    for (const [k, id] of Object.entries({ P: P.id, C: C.id })) {
      await row(`attributes ${k}`, (c) => c.get(`/api/nodes/${id}/attributes`).then((r) => `${r.status()}`));
      await row(`versions ${k}`, (c) => c.get(`/api/nodes/${id}/versions`).then((r) => `${r.status()}`));
      await row(`history ${k}`, (c) => c.get(`/api/nodes/${id}/history`).then((r) => `${r.status()}`));
      await row(`export.html ${k}`, (c) => c.get(`/api/nodes/${id}/export.html`).then((r) => `${r.status()}`));
    }
    await row("search", (c) => txt(c.get(`/api/nodes/search?q=${W}`)));
    await row("query", (c) => txt(c.post("/api/query", { ...H, data: { where: [], limit: 500 } })));
    await row("sync since max-60", (c) => txt(c.post("/api/sync", { ...H, data: { since: Number(db("select max(id) from domain_events")) - 60 } })));
    await row("bootstrap slim", (c) => txt(c.get("/api/bootstrap?bodies=none")));
    await row("events by target P", (c) => c.get(`/api/events?target_id=${P.id}`).then(async (r) => `${r.status()}:${(await r.json()).count ?? "?"}`));
    await row("events recent", (c) => txt(c.get("/api/events?limit=100")));
    await row("versions recent", (c) => txt(c.get("/api/versions/recent")));
    await row("trash", (c) => txt(c.get("/api/nodes/trash")));
    await row("canvas", (c) => txt(c.get(`/api/canvases/${cv.id}`)));
    await row("children of P via query parent", (c) => txt(c.post("/api/query", { ...H, data: { where: [{ field: "parent_id", op: "eq", value: P.id }] } })));
    await row("export markdown.zip", (c) => c.get("/api/export/markdown.zip").then(async (r) => { const buf = (await r.body()).toString("latin1"); return `${r.status()}:${["O", "P", "C"].filter((k) => buf.includes(`Per02 ${k} ${s}`)).join("") || "-"}`; }));
    m["agent getNode P / C"] = { owner: "n/a", B: `${(await (await agent.post("/api/mcp/tools/getNode", { data: { args: { id: P.id } } })).text()).slice(0, 40)} / ${(await (await agent.post("/api/mcp/tools/getNode", { data: { args: { id: C.id } } })).text()).slice(0, 40)}` };
    m["agent searchNodes"] = { owner: "n/a", B: seen(await (await agent.post("/api/mcp/tools/searchNodes", { data: { args: { query: W } } })).text()) };
    out.matrix = m;
    // Details for the suspicious rows.
    const syncB = await (await b.post("/api/sync", { ...H, data: { since: Number(db("select max(id) from domain_events")) - 80 } })).json();
    const syncTxt = JSON.stringify(syncB);
    out.syncDetail = { mentionsD: syncTxt.includes(D.id), dTitle: syncTxt.includes(`Per02 D ${s}`), pTitle: syncTxt.includes(`Per02 P ${s}`), context: (() => { const i = syncTxt.indexOf(D.id); return i < 0 ? null : syncTxt.slice(Math.max(0, i - 120), i + 60); })() };
    const cvB = await (await b.get(`/api/canvases/${cv.id}`)).text();
    out.canvasDetail = { hasPid: cvB.includes(P.id), hasPtitle: cvB.includes(`Per02 P ${s}`), hasCtitle: cvB.includes(`Per02 C ${s}`), hasPbody: cvB.includes(`Per02 P ${s} ${W}`), sample: (() => { const i = cvB.indexOf(P.id); return i < 0 ? null : cvB.slice(Math.max(0, i - 80), i + 160); })() };
    const ghost = "00000000-0000-4000-8000-000000000000";
    out.missingIdCodes = Object.fromEntries(await Promise.all(["", "/attributes", "/versions", "/history", "/export.html"].map(async (suf) => [suf || "GET", `${(await b.get(`/api/nodes/${ghost}${suf}`)).status()} vs restricted ${(await b.get(`/api/nodes/${P.id}${suf}`)).status()}`])));
    out.leaks = Object.entries(m).filter(([, v]) => /[PCD]/.test((v.B.split(":")[1] ?? v.B).replace(/-/g, "")) && !/^(4\d\d|ERR)/.test(v.B)).map(([k, v]) => `${k} → ${v.B}`);
  } finally {
    await agent.dispose(); await ctx.close();
    await req.delete(`/api/canvases/${cv.id}`, H).catch(() => {});
    for (const n of [C, P, O]) await req.delete(`/api/nodes/${n.id}`, H).catch(() => {});
    await req.delete(`/api/spaces/${lockSpace}`, H).catch(() => {});
    await req.delete(`/api/actors/${bActor.id}`, H).catch(() => {});
    await req.delete(`/api/actors/${agentActor.id}`, H).catch(() => {});
    console.log("PER02 " + JSON.stringify(out, null, 2));
  }
});
