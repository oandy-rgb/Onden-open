// Real database: a member removed from a space keeps no trace of that space's notes in what the server sends
// them (bootstrap, sync delta, event feed, inbox). Everything the member authored while they had access (a link,
// a tag, an attribute, a pointer, a focus session, an AI session, a suggestion, their own edit events) points at
// notes they can no longer read; none of it may carry the note's id or text.
// Also: the sync delta's membership diff is what tells the device to drop the notes it already holds.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, event } from "../db.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { TASKS_MODULE_ID } from "../spine/taskIdentity.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => sessionExternalId ? { user: { id: sessionExternalId, name: "Member", email: `${sessionExternalId}@sweep.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app } = await import("../app.js");

let ownerExt = "", memberExt = "", ownerId = "", memberId = "";

async function request(who: "owner" | "member", path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  sessionExternalId = who === "owner" ? ownerExt : memberExt;
  try {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  } finally { sessionExternalId = null; }
}

const hidden: Array<{ id: string; title: string }> = [];
/** Ids of events the member keeps: about a task, about a note in the trash. */
const keptEventIds = { focus: randomUUID(), edge: randomUUID() };
let visibleId = "";

async function note(title: string, space: string): Promise<string> {
  return (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes(workspace_id, source_type, node_type, title, slug, markdown, space_id)
     VALUES($1,'manual','content',$2,$3,$4,$5) RETURNING id::text`,
    [ownWorkspace, title, randomUUID(), `body of ${title}`, space])).rows[0]!.id;
}

describe.skipIf(!isTestDatabase())("a member removed from a space (read sweep)", () => {
  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Removed member', $1) RETURNING id::text`, [`rm-${randomUUID()}`])).rows[0]!.id;
    const actor = async (label: string) => {
      const external = `rm-${label}-${randomUUID()}`;
      const id = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1,$2,'human',$3) RETURNING id::text`, [ownWorkspace, label, external])).rows[0]!.id;
      return { id, external };
    };
    const o = await actor("owner"), m = await actor("member");
    ownerId = o.id; ownerExt = o.external; memberId = m.id; memberExt = m.external;
    await setWorkspaceOwner(ownWorkspace, ownerId);
    const hiddenSpace = await makeSpace(ownWorkspace, "secret", [{ id: ownerId, permission: "edit" }, { id: memberId, permission: "edit" }]);
    const openSpace = await makeSpace(ownWorkspace, "open", [{ id: ownerId, permission: "edit" }, { id: memberId, permission: "edit" }]);
    visibleId = await note("Visible zzvisible", openSpace);
    for (const t of ["Hidden zzh1", "Hidden zzh2", "Hidden zzh3"]) hidden.push({ id: await note(t, hiddenSpace), title: t });
    const [h1, h2, h3] = hidden.map((h) => h.id) as [string, string, string];

    // What the member authored while they could write in the secret space, one row per channel.
    await seedQ(`INSERT INTO node_edges(workspace_id, source_node_id, target_node_id, edge_type, status) VALUES($1,$2,$3,'related','active'),($1,$3,$2,'related','active')`, [ownWorkspace, h1, visibleId]);
    await seedQ(`INSERT INTO node_attributes(workspace_id, node_id, key, value, value_type) VALUES($1,$2,'zzkey','zzh1-attr','text')`, [ownWorkspace, h1]);
    await seedQ(`INSERT INTO note_pointers(workspace_id, target_id) VALUES($1,$2)`, [ownWorkspace, h2]);
    await seedQ(`INSERT INTO node_positions(workspace_id, node_id, surface, x, y) VALUES($1,$2,'graph',1,2)`, [ownWorkspace, h2]);
    await seedQ(`INSERT INTO ai_suggestions(workspace_id, target_type, target_id, suggestion_type, status, payload) VALUES($1,'node',$2,'summary','pending','{"summary":"zzh3-suggested"}')`, [ownWorkspace, h3]);
    await seedQ(`INSERT INTO focus_sessions(id, workspace_id, actor_id, task_id, started_at) VALUES($1,$2,$3,$4,now())`, [randomUUID(), ownWorkspace, memberId, h3]);
    await seedQ(`INSERT INTO block_anchors(workspace_id, note_id, anchor_id, at_body_hash, from_utf16, to_utf16, quote) VALUES($1,$2,'zzanchor1',(SELECT encode(sha256(convert_to(COALESCE(markdown, ''), 'UTF8')), 'hex') FROM content_nodes WHERE id = $2),0,5,'zzh1 quoted')`, [ownWorkspace, h1]);
    await seedQ(`INSERT INTO block_link_bindings(workspace_id, note_id, anchor_id, link_text) VALUES($1,$2,'zzanchor1','zzh1 link')`, [ownWorkspace, h1]);
    await seedQ(`INSERT INTO ai_edit_suggestions(workspace_id, node_id, space_id, agent_actor_id, base_markdown, base_title, proposal_hash) VALUES($1,$2,$3,$4,'zzh2 base','zzh2 title','ph')`, [ownWorkspace, h2, hiddenSpace, memberId]);
    for (const [type, target, payload] of [
      ["NODE_UPDATED", "node", { title: "zzh1-edited", body_hash: "h" }],
      ["EDGE_CREATED", "edge", { edge_type: "related", source_node_id: h1, target_node_id: visibleId }],
      ["FOCUS_STARTED", "focus_session", { task_id: h3 }],
      ["AGENT_SESSION_STARTED", "agent_session", { node_id: h2 }],
    ] as const) await event(ownWorkspace, type, target, target === "node" ? h1 : randomUUID(), payload, "user", memberId);

    // Channels the reader's removal must not touch: a tag applied to a hidden note, a picture uploaded to one,
    // a tool call that named one; and what the member keeps after the removal (below).
    const plainTag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes(workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
       VALUES($1,'manual','class_tag','zzplaintag',$2,'','{}'::jsonb) RETURNING id::text`, [ownWorkspace, randomUUID()])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [h1, plainTag]);
    await seedQ(`INSERT INTO media_uploads(workspace_id, filename, node_id, uploader_actor_id) VALUES($1,'zzh1-picture.png',$2,$3)`, [ownWorkspace, h1, memberId]);
    await event(ownWorkspace, "AGENT_TOOL_CALLED", "tool", "getNode", { ok: true }, "user", memberId,
      { txMeta: { tool_name: "getNode", args: { keys: ["id", "tag_id", "ids"], ids: { id: h1, tag_id: plainTag, ids: [h2] } } } });
    await event(ownWorkspace, "AGENT_TOOL_CALLED", "tool", "zzharmless", { ok: true }, "user", memberId,
      { txMeta: { tool_name: "zzharmless", args: { keys: ["tag_id"], ids: { tag_id: plainTag } } } });
    // A task of the open space (not in the notes array of a bootstrap) and a note of the open space in the trash.
    const taskTag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes(workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
       VALUES($1,'manual','class_tag','zztasktag',$2,'',$3::jsonb) RETURNING id::text`, [ownWorkspace, randomUUID(), JSON.stringify({ module: TASKS_MODULE_ID })])).rows[0]!.id;
    const openTask = await note("Open task zztask", openSpace);
    await seedQ(`INSERT INTO node_tags(node_id, tag_id) VALUES($1,$2)`, [openTask, taskTag]);
    const trashed = await note("Trashed zztrashed", openSpace);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
    await event(ownWorkspace, "FOCUS_STARTED", "focus_session", keptEventIds.focus, { task_id: openTask }, "user", memberId);
    await event(ownWorkspace, "EDGE_CREATED", "edge", keptEventIds.edge, { edge_type: "related", source_node_id: visibleId, target_node_id: trashed }, "user", memberId);

    // The product path for removal: the owner removes the member from the secret space.
    const res = await request("owner", `/api/spaces/${hiddenSpace}/members/${memberId}`, { method: "DELETE" });
    expect(res.status).toBeLessThan(300);
  });

  const leaks = (text: string) => hidden.flatMap((h) => [
    text.includes(h.id) ? `id of ${h.title}` : "",
    text.includes(h.title.split(" ")[1]!) ? `text of ${h.title}` : "",
  ]).filter(Boolean);

  it.each([
    ["bootstrap", "/api/bootstrap", {}],
    ["lean bootstrap", "/api/bootstrap", { headers: { "x-onden-bootstrap": "lean2" } }],
    ["bootstrap without notes", "/api/bootstrap?nodes=none", {}],
    ["sync delta from the start", "/api/sync?since=0", {}],
    ["event feed", "/api/events?limit=200", {}],
    ["inbox", "/api/inbox", {}],
  ])("%s names nothing of the secret space", async (_name, path, init) => {
    const res = await request("member", path, init);
    expect(res.status).toBe(200);
    expect(leaks(res.text)).toEqual([]);
  });

  it.each([
    ["bootstrap", "/api/bootstrap"],
    ["bootstrap without notes", "/api/bootstrap?nodes=none"],
    ["event feed", "/api/events?limit=200"],
  ])("%s keeps the member's own events about notes they can still read (a task, a note in the trash, no note at all)", async (_name, path) => {
    const res = await request("member", path);
    for (const kept of [keptEventIds.focus, keptEventIds.edge, "zzharmless"]) expect(res.text, kept).toContain(kept);
  });

  it("the member still sees the open space's note", async () => {
    expect((await request("member", "/api/bootstrap")).text).toContain(visibleId);
  });

  it("tells the device to drop the secret notes it still holds", async () => {
    const res = await request("member", "/api/sync", { method: "POST", body: { since: 0, known: [visibleId, ...hidden.map((h) => h.id)] } });
    const delta = JSON.parse(res.text) as { nodes: { delete: string[] } };
    expect([...delta.nodes.delete].sort()).toEqual(hidden.map((h) => h.id).sort());
  });
});
