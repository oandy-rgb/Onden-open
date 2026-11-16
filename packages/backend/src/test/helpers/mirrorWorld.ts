// The server side of the local-mirror property test (properties/mirror.property.test.ts):
// a workspace of its own with an owner, a member and four spaces, and the random
// server-side changes the test applies to it through the REAL routes.
//
//   spaces: 0 = the default space (owner and member edit), 1 = A (member views),
//           2 = B (member edits), 3 = C (owner only).
//
// An op names notes, tags, … by position in what the world has created so far
// (`pick`), so a generated sequence stays meaningful as it shrinks. An op that
// the server refuses (4xx: a cycle, a trashed parent, no permission …) is a
// no-op; a 5xx is a finding and is reported by the caller.

import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import { evenOrderKey } from "@onden/markdown/contract";
import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "./persistActor.js";
import { makeSpace } from "./spaceFixtures.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import { ensureConfigNode } from "./siteConfigFixture.js";

export type Who = "owner" | "member";
export type Perm = "view" | "edit" | "none";

/** Attribute keys the ops write; `ink_data` / `pdf_annotations` are the keys a lean bootstrap leaves out. */
export const ATTRIBUTE_KEYS = ["status", "score", "due", "link", "ink_data", "pdf_annotations"] as const;
export const DEFERRED_KEYS: ReadonlySet<string> = new Set(["ink_data", "pdf_annotations"]);

export type ServerOp =
  | { op: "createNote"; by: Who; space: number; parent: number | null; title: string; body: string }
  | { op: "editNote"; by: Who; note: number; body: string }
  | { op: "renameNote"; by: Who; note: number; title: string }
  | { op: "moveNote"; note: number; parent: number | null; sort: number }
  | { op: "deleteNote"; note: number }
  | { op: "restoreNote"; note: number }
  | { op: "createTag"; name: string }
  | { op: "tagPath"; path: string }
  | { op: "renameTag"; tag: number; name: string }
  | { op: "deleteTag"; tag: number }
  | { op: "applyTag"; by: Who; note: number; tag: number }
  | { op: "removeTag"; by: Who; note: number; tag: number }
  | { op: "setAttr"; by: Who; note: number; key: number; value: string; inheritable: boolean }
  | { op: "delAttr"; note: number; key: number }
  | { op: "createEdge"; from: number; to: number }
  | { op: "deleteEdge"; edge: number }
  | { op: "createTask"; note: number; title: string; due: boolean }
  | { op: "patchTask"; task: number; status: "todo" | "doing" | "done" | "cancelled"; title: string }
  | { op: "createCanvas"; space: number; title: string }
  | { op: "placeOnCanvas"; canvas: number; note: number }
  | { op: "removeFromCanvas"; canvas: number; note: number }
  | { op: "deleteCanvas"; canvas: number }
  /** Hide (shown false) or show the board's 白板 tab, as the tab row does: its placements stay. */
  | { op: "setWhiteboardTab"; canvas: number; shown: boolean }
  | { op: "moveSpace"; note: number; space: number }
  | { op: "setMember"; space: number; perm: Perm }
  | { op: "burst"; count: number };

export type Reply = { status: number; body: unknown };

export type World = {
  workspaceId: string;
  owner: ActorCtx & { externalId: string };
  member: ActorCtx & { externalId: string };
  spaceIds: string[];
  /** One request as `who`, straight into the assembled app. */
  request(who: Who, method: string, path: string, json?: unknown): Promise<Reply>;
  /** The id of what an op created, in creation order. */
  pools: { notes: string[]; tags: string[]; edges: string[]; tasks: string[]; canvases: string[]; trashed: Set<string> };
  /** Apply one op; resolves with the replies it got (for 5xx reporting). */
  apply(op: ServerOp): Promise<Reply[]>;
  /** Wait for the background derivations (tags, links …) every write starts. */
  settle(): Promise<void>;
  /** The server's newest event id. */
  head(): Promise<number>;
};

type App = { request(path: string, init?: RequestInit): Response | Promise<Response> };

const pick = <T>(pool: readonly T[], i: number): T | undefined => (pool.length ? pool[i % pool.length] : undefined);

export async function createWorld(app: App): Promise<World> {
  const workspaceId = (await q<{ id: string }>(
    `INSERT INTO workspaces (name, slug) VALUES ('Mirror properties', $1) RETURNING id::text`, [`mirror-${randomUUID()}`])).rows[0]!.id;
  // The first human becomes the owner; the member only views the default space.
  const owner = await persistActor(workspaceId, { id: "", name: "Mirror owner", role: "admin", type: "human" });
  const member = await persistActor(workspaceId, { id: "", name: "Mirror member", role: "viewer", type: "human" });
  // The session mock logs a request in as the actor whose external_id it names.
  await q(`UPDATE actors SET external_id = id::text WHERE id = ANY($1::uuid[])`, [[owner.id, member.id]]);
  await ensureConfigNode(workspaceId);
  const defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  const spaceIds = [
    defaultSpace,
    await makeSpace(workspaceId, "A", [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "view" }]),
    await makeSpace(workspaceId, "B", [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "edit" }]),
    await makeSpace(workspaceId, "C", [{ id: owner.id, permission: "edit" }]),
  ];
  const actors = { owner: { ...owner, externalId: owner.id }, member: { ...member, externalId: member.id } };
  const pools: World["pools"] = { notes: [], tags: [], edges: [], tasks: [], canvases: [], trashed: new Set() };

  const request: World["request"] = async (who, method, path, json) => {
    const res = await app.request(path, {
      method,
      // The world plays a current page: a browser-origin write without the protocol header is refused (clientGate.ts, 426).
      headers: { origin: "http://localhost", [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL), "x-test-actor": actors[who].externalId, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
  const ok = (r: Reply) => r.status >= 200 && r.status < 300;
  const idOf = (r: Reply) => (r.body as { id?: string }).id;

  async function apply(o: ServerOp): Promise<Reply[]> {
    const replies: Reply[] = [];
    const call = async (...args: Parameters<World["request"]>) => { const r = await request(...args); replies.push(r); return r; };
    switch (o.op) {
      case "createNote": {
        const parent = o.parent === null ? undefined : pick(pools.notes, o.parent);
        const r = await call(o.by, "POST", "/api/nodes", {
          title: o.title, markdown: o.body,
          ...(parent ? { parent_id: parent } : { space_id: spaceIds[o.space % 4] }),
        });
        if (ok(r)) pools.notes.push(idOf(r)!);
        break;
      }
      case "editNote": { const n = pick(pools.notes, o.note); if (n) await call(o.by, "PATCH", `/api/nodes/${n}`, { markdown: o.body }); break; }
      case "renameNote": { const n = pick(pools.notes, o.note); if (n) await call(o.by, "PATCH", `/api/nodes/${n}`, { title: o.title }); break; }
      case "moveNote": {
        const n = pick(pools.notes, o.note);
        const parent = o.parent === null ? null : pick(pools.notes, o.parent);
        if (n && parent !== n) await call("owner", "PATCH", `/api/nodes/${n}`, { parent_id: parent ?? null, order_key: evenOrderKey(o.sort + 3) });
        break;
      }
      case "deleteNote": { const n = pick(pools.notes, o.note); if (n && ok(await call("owner", "DELETE", `/api/nodes/${n}`))) pools.trashed.add(n); break; }
      case "restoreNote": {
        const trashed = [...pools.trashed];
        const n = pick(trashed, o.note);
        if (n && ok(await call("owner", "POST", `/api/nodes/${n}/undelete`))) pools.trashed.delete(n);
        break;
      }
      case "createTag": { const r = await call("owner", "POST", "/api/tags", { name: o.name }); if (ok(r)) pools.tags.push(idOf(r)!); break; }
      case "tagPath": {
        const r = await call("owner", "POST", "/api/tags/resolve-path", { path: o.path });
        if (ok(r)) for (const id of (r.body as { created_ids?: string[] }).created_ids ?? []) pools.tags.push(id);
        break;
      }
      case "renameTag": { const t = pick(pools.tags, o.tag); if (t) await call("owner", "PATCH", `/api/tags/${t}`, { name: o.name }); break; }
      case "deleteTag": { const t = pick(pools.tags, o.tag); if (t) await call("owner", "DELETE", `/api/nodes/${t}`); break; }
      case "applyTag": {
        const [n, t] = [pick(pools.notes, o.note), pick(pools.tags, o.tag)];
        if (n && t) await call(o.by, "PUT", `/api/nodes/${n}/tags/${t}`);
        break;
      }
      case "removeTag": {
        const [n, t] = [pick(pools.notes, o.note), pick(pools.tags, o.tag)];
        if (n && t) await call(o.by, "DELETE", `/api/nodes/${n}/tags/${t}`);
        break;
      }
      case "setAttr": {
        const n = pick(pools.notes, o.note);
        if (!n) break;
        const key = ATTRIBUTE_KEYS[o.key % ATTRIBUTE_KEYS.length]!;
        const value = key === "score" ? String(o.value.length) : key === "due" ? "2026-11-0" + (1 + (o.value.length % 9))
          : key === "link" ? (pick(pools.notes, o.value.length) ?? n) : o.value;
        await call(o.by, "PUT", `/api/nodes/${n}/attributes/${key}`, {
          value, is_inheritable: o.inheritable,
          ...(key === "score" ? { value_type: "number" } : key === "due" ? { value_type: "date" } : key === "link" ? { value_type: "node_ref" } : {}),
        });
        break;
      }
      case "delAttr": {
        const n = pick(pools.notes, o.note);
        if (n) await call("owner", "DELETE", `/api/nodes/${n}/attributes/${ATTRIBUTE_KEYS[o.key % ATTRIBUTE_KEYS.length]}`);
        break;
      }
      case "createEdge": {
        const [a, b] = [pick(pools.notes, o.from), pick(pools.notes, o.to)];
        if (a && b && a !== b) { const r = await call("owner", "POST", "/api/edges", { source_node_id: a, target_node_id: b, edge_type: "related" }); if (ok(r)) pools.edges.push(idOf(r)!); }
        break;
      }
      case "deleteEdge": { const e = pick(pools.edges, o.edge); if (e) await call("owner", "DELETE", `/api/edges/${e}`); break; }
      case "createTask": {
        const n = pick(pools.notes, o.note);
        if (n) {
          const r = await call("owner", "POST", `/api/nodes/${n}/tasks`, { title: "task", ...(o.due ? { due_date: "2026-12-01" } : {}) });
          if (ok(r)) pools.tasks.push(idOf(r)!);
        }
        break;
      }
      case "patchTask": { const t = pick(pools.tasks, o.task); if (t) await call("owner", "PATCH", `/api/tasks/${t}`, { status: o.status, title: o.title }); break; }
      case "createCanvas": {
        const r = await call("owner", "POST", "/api/canvases", { title: o.title, space_id: spaceIds[o.space % 4] });
        if (ok(r)) pools.canvases.push(idOf(r)!);
        break;
      }
      case "placeOnCanvas": {
        const [c, n] = [pick(pools.canvases, o.canvas), pick(pools.notes, o.note)];
        if (c && n) await call("owner", "PATCH", `/api/boards/${c}`, { cards: { upsert: [{ nodeId: n, x: 10, y: 20 }] } });
        break;
      }
      case "removeFromCanvas": {
        const [c, n] = [pick(pools.canvases, o.canvas), pick(pools.notes, o.note)];
        if (c && n) await call("owner", "PATCH", `/api/boards/${c}`, { cards: { remove: [n] } });
        break;
      }
      case "setWhiteboardTab": {
        const c = pick(pools.canvases, o.canvas);
        if (!c) break;
        const listed = await call("owner", "GET", `/api/nodes/${c}/views`);
        const views = Array.isArray(listed.body) ? listed.body as Array<{ id: string; layout: string; layout_config?: Record<string, unknown> }> : [];
        const tab = views.find((view) => view.layout === "canvas");
        const { hidden: _hidden, ...rest } = tab?.layout_config ?? {};
        const layout_config = o.shown ? rest : { ...rest, hidden: true };
        if (tab) await call("owner", "PATCH", `/api/nodes/${c}/views/${tab.id}`, { layout_config });
        else await call("owner", "POST", `/api/nodes/${c}/views`, { name: "Canvas", layout: "canvas", layout_config });
        break;
      }
      case "deleteCanvas": { const c = pick(pools.canvases, o.canvas); if (c) await call("owner", "DELETE", `/api/canvases/${c}`); break; }
      case "moveSpace": {
        const n = pick(pools.notes, o.note);
        if (!n) break;
        const to = spaceIds[o.space % 4]!;
        const preview = await call("owner", "GET", `/api/spaces/move-preview?node=${n}&to=${to}`);
        if (ok(preview)) await call("owner", "POST", "/api/spaces/move", { node_id: n, to_space_id: to, membership_epoch: (preview.body as { membership_epoch: string }).membership_epoch });
        break;
      }
      case "setMember": {
        const space = spaceIds[o.space % 3 + 1]!; // the member never leaves the default space here
        if (o.perm === "none") await call("owner", "DELETE", `/api/spaces/${space}/members/${member.id}`);
        else await call("owner", "PUT", `/api/spaces/${space}/members/${member.id}`, { permission: o.perm });
        break;
      }
      case "burst": {
        // Enough events in a row to need more than one 500-event delta page.
        let n = pick(pools.notes, 0);
        if (!n) {
          const r = await call("owner", "POST", "/api/nodes", { title: "burst", markdown: "", space_id: spaceIds[0] });
          if (ok(r)) { n = idOf(r)!; pools.notes.push(n); }
        }
        if (n) for (let i = 0; i < o.count; i++) await call("owner", "PUT", `/api/nodes/${n}/attributes/burst`, { value: String(i) });
        break;
      }
    }
    return replies;
  }

  return {
    workspaceId, owner: actors.owner, member: actors.member, spaceIds, request, pools, apply,
    settle: () => awaitAllDispatchers(),
    head: async () => Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id), 0)::text AS m FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.m),
  };
}
