// Feature-audit deepening (2026-10-09, tick 30): PER-01 — ActorCtx freshness.
// User B keeps one signed-in session while the owner changes B's role and
// space membership (the human "scope" since spaces replaced tag scopes); B's
// very next request must use the new authority (no cached role), for writes
// and reads, with no write landing when refused.
import { test } from "@playwright/test";
import { createSpace, defaultSpaceId, moveToSpace, addToDefaultSpace, BASE, H, psql as db } from "../fullstack/helpers";


test("PER-01: role / scope change applies to the next request", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const email = `per01-${s}@example.com`, pw = `pw-${s}-x`;
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const b = ctx.request;
  const su = await (await b.post("/api/auth/sign-up/email", { ...H, data: { name: `Per01 ${s}`, email, password: pw } })).json();
  await req.post("/api/actors", { ...H, data: { name: `Per01 ${s}`, type: "human", external_id: su.user.id } });
  const actor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string; role: string }>).find((a) => a.name === `Per01 ${s}`)!;
  await addToDefaultSpace(req, actor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const shared = await defaultSpaceId(req);
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `Per01 n ${s}`, markdown: "x", space_id: shared } })).json();
  // B's "scope": only this space (B removed from the default one).
  const scopeSpace = await createSpace(req, `Per01 scope ${s}`);
  const setMember = (space: string, role: string | null) => role
    ? req.put(`/api/spaces/${space}/members/${actor.id}`, { ...H, data: { role } })
    : req.delete(`/api/spaces/${space}/members/${actor.id}`, H);
  const setActor = (data: Record<string, unknown>) => req.patch(`/api/actors/${actor.id}`, { ...H, data });
  let k = 0;
  const bWrite = async () => { k++; const r = await b.patch(`/api/nodes/${note.id}`, { ...H, data: { title: `Per01 n ${s} v${k}` } }); return `${r.status()} landed=${db(`select title from content_nodes where id='${note.id}'`) === `Per01 n ${s} v${k}`}`; };
  const bRead = async () => (await b.get(`/api/nodes/${note.id}`)).status();
  const bCreate = async () => { const r = await b.post("/api/nodes", { ...H, data: { title: `Per01 b-create ${s} ${k}` } }); return r.status(); };
  try {
    out.asEditor = { write: await bWrite(), read: await bRead(), me: (await (await b.get("/api/actors/me")).json().catch(() => ({}))).role ?? null };
    out.demote = (await setActor({ role: "viewer" })).status();
    out.asViewer = { write: await bWrite(), read: await bRead(), create: await bCreate() };
    out.promote = (await setActor({ role: "editor" })).status();
    out.asEditorAgain = { write: await bWrite(), read: await bRead() };
    out.scope = `${(await setMember(scopeSpace, "editor")).status()} ${(await setMember(shared, null)).status()}`;
    out.scopedNotInScope = { write: await bWrite(), read: await bRead() };
    await moveToSpace(req, note.id, scopeSpace);
    out.scopedInScope = { write: await bWrite(), read: await bRead() };
    await moveToSpace(req, note.id, shared);
    out.unscope = (await setMember(shared, "editor")).status();
    out.unscoped = { write: await bWrite() };
    out.events = db(`select string_agg(event_type||':'||coalesce(payload->>'title',''), ' | ' order by id) from domain_events where target_id='${note.id}' and event_type='NODE_UPDATED'`);
  } finally {
    await req.delete(`/api/actors/${actor.id}`, H).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    await req.delete(`/api/spaces/${scopeSpace}`, H).catch(() => {});
    for (const id of db(`select id from content_nodes where title like 'Per01 b-create ${s}%'`).split("\n").filter(Boolean)) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    await ctx.close();
    console.log("PER01 " + JSON.stringify(out, null, 2));
  }
});
