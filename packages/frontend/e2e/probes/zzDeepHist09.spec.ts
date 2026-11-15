// Feature-audit deepening (2026-10-09, tick 19): HIST-09 — restore keeps the
// event, its cause and its actor; a group that fails commits nothing.
// 1. Each supported event type: restore → 200, state reverted, a NEW event by
//    the restoring actor, linked to the original (tx_meta / triggered_by).
// 2. Unsupported domains (edge, task, canvas, site config) → 422, no event, no change.
// 3. Group: TAG_MERGED cascade where one member was later re-tagged by hand →
//    the whole undo refused, nothing committed (source tag stays deleted).
import { test } from "@playwright/test";
import { seedLayout, psql, H } from "../fullstack/helpers";

// The events API hides events about now-unreadable (deleted) nodes, so read the log directly.
const db = (sql: string) => psql(sql, { fieldSeparator: "\t" })
  .split("\n").filter(Boolean).map((l) => l.split("\t"));

type Ev = { id: string; event_type: string; actor_id: string; actor_type: string; triggered_by_event_id: string | null; tx_meta: Record<string, unknown> | null; target_id: string; payload: Record<string, unknown> };

test("HIST-09: restore across domains, actor/cause, group atomicity", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const req = page.request; const s = Date.now();
  const me = await (await req.get("/api/actors/me")).json().catch(() => ({}));
  out.me = { id: me.id ?? me.actor?.id, role: me.role ?? me.actor?.role };
  const events = async (q: string) => ((await (await req.get(`/api/events?${q}&limit=50`)).json()) as { events?: Ev[] } | Ev[]);
  const list = async (q: string) => { const r = await events(q); return (Array.isArray(r) ? r : r.events ?? []) as Ev[]; };
  const latest = async (target: string, type: string) => { const r = db(`select id from domain_events where target_id='${target}' and event_type='${type}' order by id desc limit 1`)[0]; return r ? ({ id: r[0] } as Ev) : undefined; };
  const latestType = async (type: string, like: string) => { const r = db(`select id from domain_events where event_type='${type}' and (payload::text like '%${like}%' or target_id::text='${like}') order by id desc limit 1`)[0]; return r ? ({ id: r[0] } as Ev) : undefined; };
  const maxId = async () => Number(db("select coalesce(max(id),0) from domain_events")[0][0]);
  const restore = async (id: string, body: Record<string, unknown> = {}) => { const r = await req.post(`/api/events/${id}/restore`, { ...H, data: body }); return { status: r.status(), body: await r.json().catch(() => ({})) }; };
  const node = async (id: string) => { const r = await req.get(`/api/nodes/${id}`); return r.status() === 200 ? await r.json() : { status: r.status() }; };
  const after = async (since: number) => db(`select id, event_type, actor_id, coalesce(triggered_by_event_id::text,''), coalesce(tx_meta->>'restored_from',''), coalesce(tx_meta->>'ui_context','') from domain_events where id>${since} order by id`).map(([id, type, actor, trig, from, ui]) => ({ id, type, actor: actor.slice(0, 8), trig, from, ui }));
  const mk = async (title: string, extra: Record<string, unknown> = {}) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, ...extra } })).json()) as { id: string; title: string; node_type?: string };

  const cases: Record<string, unknown> = {};
  const run = async (name: string, eventPromise: Promise<Ev | undefined>, check: () => Promise<unknown>) => {
    const ev = await eventPromise;
    if (!ev) { cases[name] = "event not found"; return; }
    const since = await maxId();
    const r = await restore(ev.id);
    cases[name] = { original: ev.id, status: r.status, err: r.body.error, state: await check(), newEvents: await after(since) };
  };
  try {
    // ── 1. supported types ──
    const n1 = await mk(`H09 a ${s}`);
    await req.patch(`/api/nodes/${n1.id}`, { ...H, data: { title: `H09 a2 ${s}` } });
    await run("NODE_UPDATED", latest(n1.id, "NODE_UPDATED"), async () => (await node(n1.id)).title);
    const n2 = await mk(`H09 b ${s}`);
    await run("NODE_CREATED", latest(n2.id, "NODE_CREATED"), async () => { const x = await node(n2.id); return x.deleted_at ?? x.status ?? "live"; });
    const n3 = await mk(`H09 c ${s}`);
    await req.delete(`/api/nodes/${n3.id}`, H);
    await run("NODE_DELETED", latest(n3.id, "NODE_DELETED"), async () => { const x = await node(n3.id); return x.deleted_at ?? x.status ?? "live"; });
    await req.put(`/api/nodes/${n1.id}/attributes/h09_${s % 1000}`, { ...H, data: { value: "v1", value_type: "text" } });
    await run("ATTRIBUTE_SET", latestType("ATTRIBUTE_SET", n1.id), async () => (await req.get(`/api/nodes/${n1.id}/attributes`)).json().then((a) => JSON.stringify(a).includes(`h09_${s % 1000}`)));
    // tag apply / remove
    const mkTag = async (name: string) => { const r = await (await req.post("/api/tags/resolve-path", { ...H, data: { path: name } })).json(); return { id: r.leaf_id as string, title: name }; };
    const tag = await mkTag(`h09tag${s}`);
    out.tagType = (await node(tag.id)).node_type;
    await req.put(`/api/nodes/${n1.id}/tags/${tag.id}`, H);
    await run("TAG_APPLIED", latest(n1.id, "TAG_APPLIED").then(async (e) => e ?? latestType("TAG_APPLIED", tag.id)), async () => JSON.stringify((await node(n1.id)).tags ?? (await (await req.get(`/api/nodes/${n1.id}/tags`)).json().catch(() => []))).includes(tag.id));
    await req.put(`/api/nodes/${n1.id}/tags/${tag.id}`, H);
    await req.delete(`/api/nodes/${n1.id}/tags/${tag.id}`, H);
    await run("TAG_REMOVED", latest(n1.id, "TAG_REMOVED").then(async (e) => e ?? latestType("TAG_REMOVED", tag.id)), async () => JSON.stringify(await (await req.get(`/api/nodes/${n1.id}/tags`)).json().catch(() => [])).includes(tag.id));
    await req.patch(`/api/tags/${tag.id}`, { ...H, data: { color: "#ff0000" } });
    await run("TAG_UPDATED", latest(tag.id, "TAG_UPDATED"), async () => (await (await req.get(`/api/tags/${tag.id}`)).json().catch(() => ({}))).color ?? null);
    // restore of a restore (undo the undo) and double restore
    const r1 = cases.NODE_UPDATED as { newEvents: Array<{ id: string; type: string }> };
    const restoreEv = r1?.newEvents?.find((e) => e.type === "NODE_UPDATED");
    if (restoreEv) {
      const again = await restore(restoreEv.id);
      cases.undoTheUndo = { status: again.status, err: again.body.error, title: (await node(n1.id)).title };
    }
    const orig = (cases.NODE_UPDATED as { original: string }).original;
    const twice = await restore(orig);
    cases.restoreOriginalAgain = { status: twice.status, err: twice.body.error, detail: String(twice.body.detail ?? "").slice(0, 80) };
    out.cases = cases;

    // ── 2. unsupported domains ──
    const unsup: Record<string, unknown> = {};
    const tryU = async (name: string, ev: Ev | undefined) => {
      if (!ev) { unsup[name] = "no event"; return; }
      const since = await maxId(); const r = await restore(ev.id);
      unsup[name] = { status: r.status, err: r.body.error, newEvents: (await after(since)).length };
    };
    const e1 = await req.post("/api/edges", { ...H, data: { source_node_id: n1.id, target_node_id: n2.id, edge_type: "related" } });
    out.edgeCreate = e1.status();
    await tryU("EDGE_*", await latestType("EDGE_CREATED", "") ?? (db("select id from domain_events where event_type like 'EDGE%' order by id desc limit 1")[0] ? { id: db("select id from domain_events where event_type like 'EDGE%' order by id desc limit 1")[0][0] } as Ev : undefined));
    const cv = await (await req.post("/api/canvases", { ...H, data: { title: `H09 cv ${s}` } })).json();
    await seedLayout(req, cv.id, { ...H, data: { data: { nodes: [{ nodeId: n1.id, x: 1, y: 1 }] } } });
    await tryU("CANVAS_UPDATED", await latest(cv.id, "CANVAS_UPDATED"));
    for (const t of ["SITE_CONFIG_UPDATED", "TASK_UPDATED", "TASK_CREATED", "REVIEW_GRADED", "RELATION_CREATED", "MEDIA_UPLOADED", "NODE_PURGED", "PUBLISH_SNAPSHOT_CREATED"]) {
      const r = db(`select id from domain_events where event_type='${t}' order by id desc limit 1`)[0];
      await tryU(t, r ? ({ id: r[0] } as Ev) : undefined);
    }
    await req.delete(`/api/canvases/${cv.id}`, H);
    out.unsupported = unsup;

    // ── 3. group atomicity: TAG_MERGED cascade with a conflicting member ──
    const src = await mkTag(`h09src${s}`);
    const dst = await mkTag(`h09dst${s}`);
    const m1 = await mk(`H09 m1 ${s}`); const m2 = await mk(`H09 m2 ${s}`);
    for (const m of [m1, m2]) await req.put(`/api/nodes/${m.id}/tags/${src.id}`, H);
    const merge = await req.post(`/api/tags/${src.id}/merge`, { ...H, data: { target_id: dst.id } });
    out.merge = { status: merge.status(), body: JSON.stringify(await merge.json().catch(() => ({}))).slice(0, 120) };
    const mergeEv = await latest(src.id, "TAG_MERGED") ?? await latestType("TAG_MERGED", src.id);
    // Later hand edit: remove dst from m2 and add it back (new membership state).
    await req.delete(`/api/nodes/${m2.id}/tags/${dst.id}`, H);
    await req.put(`/api/nodes/${m2.id}/tags/${dst.id}`, H);
    const preview = await req.get(`/api/events/${mergeEv?.id}/restore-preview?cascade=true`).then(async (r) => ({ s: r.status(), b: JSON.stringify(await r.json().catch(() => ({}))).slice(0, 200) })).catch(() => null);
    const since = await maxId();
    const gr = await restore(mergeEv!.id, { cascade: true });
    out.groupRestore = {
      mergeEvent: mergeEv?.id, status: gr.status, err: gr.body.error, detail: String(gr.body.detail ?? "").slice(0, 120), preview,
      srcState: await node(src.id).then((x) => x.deleted_at ? "deleted" : x.status ?? "live"),
      m1Tags: JSON.stringify(await (await req.get(`/api/nodes/${m1.id}/tags`)).json().catch(() => [])).includes(src.id) ? "has src" : "no src",
      newEvents: await after(since),
    };
    // Without the conflict: merge again and undo cleanly.
    const src2 = await mkTag(`h09src2${s}`);
    await req.put(`/api/nodes/${m1.id}/tags/${src2.id}`, H);
    await req.post(`/api/tags/${src2.id}/merge`, { ...H, data: { target_id: dst.id } });
    const mergeEv2 = await latest(src2.id, "TAG_MERGED") ?? await latestType("TAG_MERGED", src2.id);
    const since2 = await maxId();
    const gr2 = await restore(mergeEv2!.id, { cascade: true });
    out.groupRestoreClean = { status: gr2.status, err: gr2.body.error, cascade: (gr2.body.cascade ?? []).map((c: { event_type: string; result: string }) => `${c.event_type}:${c.result}`),
      src2State: await node(src2.id).then((x) => x.deleted_at ? "deleted" : x.status ?? "live"),
      newEvents: (await after(since2)).map((e) => `${e.id} ${e.type} trig=${e.trig} from=${e.from}`) };
    // Fresh member, fresh tags: full merge undo moves memberships back.
    const a = await mkTag(`h09a${s}`); const b = await mkTag(`h09b${s}`); const m3 = await mk(`H09 m3 ${s}`);
    await req.put(`/api/nodes/${m3.id}/tags/${a.id}`, H);
    const mg = await (await req.post(`/api/tags/${a.id}/merge`, { ...H, data: { target_id: b.id } })).json();
    const tagsOf = async (id: string) => { const j = await (await req.get(`/api/nodes/${id}/tags`)).json().catch(() => []); const t = JSON.stringify(j); return { a: t.includes(a.id), b: t.includes(b.id) }; };
    const beforeUndo = await tagsOf(m3.id);
    const since3 = await maxId();
    const gr3 = await restore(String(mg.merge_event_id), { cascade: true });
    out.groupRestoreFull = { merge: mg, beforeUndo, status: gr3.status, err: gr3.body.error,
      cascade: (gr3.body.cascade ?? []).map((c: { event_type: string; result: string }) => `${c.event_type}:${c.result}`),
      afterUndo: await tagsOf(m3.id), aState: await node(a.id).then((x) => x.deleted_at ? "deleted" : x.status ?? "live"),
      newEvents: (await after(since3)).map((e) => `${e.id} ${e.type} trig=${e.trig} from=${e.from}`) };
  } finally {
    console.log("HIST09 " + JSON.stringify(out, null, 2));
  }
});
