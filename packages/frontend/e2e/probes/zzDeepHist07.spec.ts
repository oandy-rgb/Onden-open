// Feature-audit deepening (2026-10-08): HIST-07 — preview + restore for each
// common event type (title/body update, attribute set/delete, tag apply/
// remove, edge create, task status, node delete), restore twice (already in
// state), restore after a later conflicting edit (state_conflict; force), and
// as_new_node for a body edit.
import { test } from "@playwright/test";
import { BASE, H, PAGE } from "../fullstack/helpers";

type Ev = { id: string; event_type: string };

test("HIST-07: restore per event type, conflicts, force, as_new_node", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const mk = async (title: string, md = "v1") => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: md } })).json()).id as string;
  const latest = async (id: string, type?: RegExp): Promise<Ev | undefined> => { const r = await (await req.get(`/api/events?target_id=${id}&limit=30`)).json(); const list = (r.events ?? r) as Ev[]; return list.find((e) => !type || type.test(e.event_type)); };
  const restore = async (ev: Ev | undefined, body: Record<string, unknown> = {}) => { if (!ev) return "no event"; const p = await req.get(`/api/events/${ev.id}/preview`); const r = await req.post(`/api/events/${ev.id}/restore`, { ...H, data: body }); return `${ev.event_type} preview=${p.status()} restore=${r.status()} ${(await r.text()).slice(0, 90)}`; };
  const N = await mk(`H07 ${stamp}`);
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `h07t${stamp}`, fields: [{ name: "score", type: "number" }] } })).json();
  const res: Record<string, string> = {};
  await req.patch(`/api/nodes/${N}`, { ...H, data: { markdown: "v2 body" } });
  res.bodyUpdate = await restore(await latest(N, /NODE_UPDATED/));
  res.bodyAfter = (await (await req.get(`/api/nodes/${N}`)).json()).markdown;
  res.bodyAgain = await restore(await latest(N, /NODE_UPDATED/));
  await req.put(`/api/nodes/${N}/attributes/score`, { ...H, data: { value: "5", value_type: "number" } });
  res.attrSet = await restore(await latest(N, /ATTRIBUTE_SET/));
  await req.put(`/api/nodes/${N}/attributes/score`, { ...H, data: { value: "6", value_type: "number" } });
  await req.delete(`/api/nodes/${N}/attributes/score`, { headers: PAGE });
  res.attrDelete = await restore(await latest(N, /ATTRIBUTE_DELETED/));
  await req.put(`/api/nodes/${N}/tags/${tag.id}`, { ...H, data: {} });
  res.tagApply = await restore(await latest(N, /TAG|MEMBERSHIP/));
  await req.put(`/api/nodes/${N}/tags/${tag.id}`, { ...H, data: {} });
  await req.delete(`/api/nodes/${N}/tags/${tag.id}`, { headers: PAGE });
  res.tagRemove = await restore(await latest(N, /TAG.*REMOV|UNTAG|TAG_DETACH/));
  const M = await mk(`H07b ${stamp}`);
  const e = await (await req.post("/api/edges", { ...H, data: { source_node_id: N, target_node_id: M, edge_type: "knowledge_link" } })).json();
  res.edgeCreate = await restore(await latest(e.id, /EDGE_CREATED/));
  const t = await (await req.post(`/api/nodes/${N}/tasks`, { ...H, data: { title: `H07T ${stamp}` } })).json();
  await req.patch(`/api/tasks/${t.id}`, { ...H, data: { status: "done" } });
  res.taskStatus = await restore(await latest(t.id, /ATTRIBUTE_SET|TASK/));
  const D = await mk(`H07del ${stamp}`);
  await req.delete(`/api/nodes/${D}`, { headers: PAGE });
  res.nodeDelete = await restore(await latest(D, /NODE_DELETED/));
  res.nodeDeleteLive = String((await req.get(`/api/nodes/${D}`)).status());
  // Conflict: edit body twice, restore the first edit.
  const C = await mk(`H07c ${stamp}`, "base");
  await req.patch(`/api/nodes/${C}`, { ...H, data: { markdown: "first change" } });
  const firstEv = await latest(C, /NODE_UPDATED/);
  await req.patch(`/api/nodes/${C}`, { ...H, data: { markdown: "second change" } });
  res.conflict = await restore(firstEv);
  res.conflictForce = await restore(firstEv, { force: true });
  res.afterForce = (await (await req.get(`/api/nodes/${C}`)).json()).markdown;
  res.asNew = await restore(firstEv, { as_new_node: true });
  out.results = res;
  console.log("HIST07 " + JSON.stringify(out, null, 2));
});
