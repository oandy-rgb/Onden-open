// @ts-nocheck
// Snapshot of src/lib/data/storeOps.ts as released (npm run capture:client-writes); not type-checked here.
// Pure transforms over the Bootstrap state tree. Extracted from useAppData so
// the merge logic (especially the sync-delta application) is unit-testable
// without React. No I/O, no hooks — every function returns a new tree.

import type { Bootstrap, ContentNode, NodeTask } from "../api";
import type { SyncDelta, AppliedSyncDelta } from "../localDb";
import { applyTagCatalog } from "../tagProjection";
import { applyCanvasMembershipChange } from "../canvasMemberships";
import { pendingFields } from "./optimisticFields";

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return [...list.filter((x) => x.id !== item.id), item];
}

export function patchNode(data: Bootstrap, nodeId: string, patch: Partial<ContentNode>): Bootstrap {
  const nodes = data.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
  // Tag names are another projection of this node's title. Keep existing tag
  // chips / schema headings consistent through optimistic edits and rollback;
  // the schema pack's independent name is not renamed here (migration 074).
  // A tag's hidden flag (D104) is the same field on both projections.
  const renamedTag = patch.title !== undefined && nodes.find(n => n.id === nodeId)?.node_type === "class_tag";
  const hiddenTag = patch.hidden !== undefined && !!data.tags?.some(tag => tag.id === nodeId);
  return { ...data, nodes, ...((renamedTag || hiddenTag) && data.tags ? {
    tags: data.tags.map(tag => tag.id !== nodeId ? tag : {
      ...tag, ...(renamedTag ? { name: patch.title! } : {}), ...(hiddenTag ? { hidden: patch.hidden } : {}),
    }),
  } : {}) };
}

export function addNode(data: Bootstrap, node: ContentNode): Bootstrap {
  return { ...data, nodes: [...data.nodes, node] };
}

export function dropNode(data: Bootstrap, nodeId: string): Bootstrap {
  // Cascade the node's dependents exactly like the sync-delta delete
  // (applySyncDelta's nodes.delete branch): otherwise an optimistic delete drops
  // the node but leaves its edges/tasks dangling until a full refresh.
  //   • tasks HOSTED by the node (node_id) AND — when the node IS a task node —
  //     the task whose OWN id matches (node_id-only left a task-node lingering);
  //   • any edge touching the node on either end.
  // (Attributes ride on the node object in this in-memory tree, so they go with
  //  it; the SQLite mirror clears node_attributes in localDb.removeNode.)
  return {
    ...data,
    nodes: data.nodes.filter((n) => n.id !== nodeId),
    ...(data.tags ? { tags: data.tags.filter(tag => tag.id !== nodeId) } : {}),
    tasks: data.tasks.filter((t) => t.node_id !== nodeId && t.id !== nodeId),
    edges: data.edges.filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId),
    ...(data.pointers ? { pointers: data.pointers.filter((p) => p.parent_id !== nodeId && p.target_id !== nodeId) } : {}),
  };
}

export function setNodeAttr(data: Bootstrap, nodeId: string, key: string, value: string): Bootstrap {
  return {
    ...data,
    nodes: data.nodes.map((n) =>
      n.id === nodeId ? { ...n, attrs: { ...(n.attrs ?? {}), [key]: value } } : n,
    ),
  };
}

export function dropNodeAttr(data: Bootstrap, nodeId: string, key: string): Bootstrap {
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const next = { ...(n.attrs ?? {}) };
      delete next[key];
      return { ...n, attrs: next };
    }),
  };
}

export function patchTask(data: Bootstrap, taskId: string, patch: Partial<NodeTask>): Bootstrap {
  return { ...data, tasks: data.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) };
}

/** Which membership list a tag lands in. A class/schema tag (carries a schema)
 *  goes to class_tag_ids; a plain label tag (e.g. #toread) to label_tag_ids.
 *  Mirrors the dual lists the bootstrap projects (see ContentNode). */
function tagMembershipKey(data: Bootstrap, tagId: string): "class_tag_ids" | "label_tag_ids" {
  const tag = data.nodes.find((n) => n.id === tagId);
  // schema-bearing tag (tag_schema present) => class membership; otherwise label.
  return tag?.tag_schema || data.tags?.find(candidate => candidate.id === tagId)?.schema_id
    ? "class_tag_ids" : "label_tag_ids";
}

/** Optimistically record a tag application on a node (grow-set, idempotent). */
export function addNodeTag(data: Bootstrap, nodeId: string, tagId: string): Bootstrap {
  const key = tagMembershipKey(data, tagId);
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const cur = n[key] ?? [];
      if (cur.includes(tagId)) return n;
      return { ...n, [key]: [...cur, tagId] };
    }),
  };
}

/** Optimistically drop a tag from a node (both lists — we don't always know
 *  which one held it, and removing from the wrong one is a harmless no-op). */
export function dropNodeTag(data: Bootstrap, nodeId: string, tagId: string): Bootstrap {
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      return {
        ...n,
        class_tag_ids: (n.class_tag_ids ?? []).filter((id) => id !== tagId),
        label_tag_ids: (n.label_tag_ids ?? []).filter((id) => id !== tagId),
      };
    }),
  };
}

/** True when the delta carries nothing to apply (the early-return guard —
 *  MUST include attribute deltas; see useAppData's original comment about
 *  dispatcher-driven attr updates being silently dropped). */
export function isEmptyDelta(delta: SyncDelta): boolean {
  return (
    delta.nodes.upsert.length + delta.nodes.delete.length +
    delta.edges.upsert.length + delta.edges.delete.length +
    delta.tasks.upsert.length + delta.tasks.delete.length +
    delta.attributes.upsert.length + delta.attributes.delete.length +
    (delta.pointers?.upsert.length ?? 0) + (delta.pointers?.delete.length ?? 0) +
    (delta.canvas_memberships?.upsert.length ?? 0) + (delta.canvas_memberships?.delete?.length ?? 0) === 0 &&
    !delta.workspace && delta.tags === undefined && delta.site_config === undefined
  );
}

/** Apply a /api/sync delta to the in-memory tree. Node/edge/task rows are
 *  whole-row replaces (sync returns the same shape bootstrap does); attribute
 *  deltas patch each node's `attrs` map in place — deletes remove the key,
 *  upserts overwrite. */
export function applySyncDelta(prev: Bootstrap, delta: AppliedSyncDelta): Bootstrap {
  let nodes = prev.nodes;
  for (const n of delta.nodes.upsert) nodes = [...nodes.filter((x) => x.id !== n.id), n];
  // Node deletes include revocation deletes (a node that left the read set via a
  // permission change — HIGH gap #2). Prune the node's dependent tasks/edges too,
  // so a revoked node leaves no dangling task row or half-edge in memory (mirrors
  // dropNode + the worker's cascade). Backlinks to a revoked node are pruned by
  // the edge's other end becoming unreadable, but a stale edge already in memory
  // must go regardless of which end was revoked.
  const deletedNodeIds = new Set(delta.nodes.delete);
  for (const id of delta.nodes.delete) nodes = nodes.filter((x) => x.id !== id);
  if (delta.attributes.upsert.length || delta.attributes.delete.length) {
    const attrUpsertByNode = new Map<string, Record<string, string>>();
    for (const a of delta.attributes.upsert) {
      const m = attrUpsertByNode.get(a.node_id) ?? {};
      m[a.key] = a.value;
      attrUpsertByNode.set(a.node_id, m);
    }
    const attrDeleteByNode = new Map<string, Set<string>>();
    for (const a of delta.attributes.delete) {
      const s = attrDeleteByNode.get(a.node_id) ?? new Set();
      s.add(a.key);
      attrDeleteByNode.set(a.node_id, s);
    }
    nodes = nodes.map((n) => {
      const adds = attrUpsertByNode.get(n.id);
      const removes = attrDeleteByNode.get(n.id);
      if (!adds && !removes) return n;
      const next = { ...(n.attrs ?? {}) };
      if (adds) Object.assign(next, adds);
      if (removes) for (const k of removes) delete next[k];
      return { ...n, attrs: next };
    });
  }
  let edges = prev.edges;
  for (const e of delta.edges.upsert) edges = [...edges.filter((x) => x.id !== e.id), e];
  for (const id of delta.edges.delete) edges = edges.filter((x) => x.id !== id);
  if (deletedNodeIds.size > 0) {
    edges = edges.filter((e) => !deletedNodeIds.has(e.source_node_id) && !deletedNodeIds.has(e.target_node_id));
  }
  let tasks = prev.tasks;
  for (const t of delta.tasks.upsert) tasks = [...tasks.filter((x) => x.id !== t.id), t];
  for (const id of delta.tasks.delete) tasks = tasks.filter((x) => x.id !== id);
  if (deletedNodeIds.size > 0) {
    // Drop tasks HOSTED by a deleted node (node_id) AND — when the deleted id is
    // itself a TASK node — the task whose OWN id matches (revoked task: it arrives
    // in nodes.delete but must clear the local tasks projection by id, not host).
    tasks = tasks.filter((t) => !deletedNodeIds.has(t.node_id) && !deletedNodeIds.has(t.id));
  }
  let pointers = prev.pointers;
  if (pointers && (delta.pointers || deletedNodeIds.size > 0)) {
    for (const p of delta.pointers?.upsert ?? []) pointers = upsertById(pointers, p);
    const removed = new Set(delta.pointers?.delete ?? []);
    pointers = pointers.filter((p) => !removed.has(p.id)
      && !deletedNodeIds.has(p.target_id) && !(p.parent_id && deletedNodeIds.has(p.parent_id)));
  } else if (!pointers && delta.pointers?.upsert.length) {
    pointers = delta.pointers.upsert;
  }
  // The boards each note is on (D98): the worker resolved replace_for into
  // explicit deletes; a deleted note or canvas takes its memberships along.
  const memberships = delta.canvas_memberships || deletedNodeIds.size > 0
    ? applyCanvasMembershipChange(prev.canvas_memberships, delta.canvas_memberships
      ? { upsert: delta.canvas_memberships.upsert, delete: delta.canvas_memberships.delete ?? [] }
      : undefined, deletedNodeIds)
    : prev.canvas_memberships;
  const workspace = delta.workspace ?? prev.workspace;
  // Own create input can survive revocation of a same-ID remote projection;
  // its old metadata, attributes and relations above must still be removed.
  for (const n of delta.pendingCreations ?? []) nodes = upsertById(nodes, n);
  const tags = applyTagCatalog(prev.tags, delta);
  return {
    ...prev, nodes, edges, tasks, workspace, tags, ...(pointers ? { pointers } : {}),
    ...(memberships ? { canvas_memberships: memberships } : {}), ...syncedSettings(prev, delta),
  };
}

/** The site config and chrome a delta re-shipped (D119), as a bootstrap's
 *  replace them — except what this device is still saving (the workspace
 *  writer's optimistic journal, saveDesign): that keeps its local value, and
 *  the writer settles it with the server's reply. */
function syncedSettings(prev: Bootstrap, delta: SyncDelta): Partial<Pick<Bootstrap, "site_config" | "chrome">> {
  if (delta.site_config === undefined) return {};
  const resource = `workspace:${prev.workspace.id}`;
  const site_config = { ...(delta.site_config ?? {}) };
  for (const key of pendingFields(`${resource}:config`)) {
    const name = String(key);
    if (prev.site_config && Object.hasOwn(prev.site_config, name)) site_config[name] = prev.site_config[name];
    else delete site_config[name];
  }
  return { site_config, ...(pendingFields(resource).has("chrome") ? {} : { chrome: delta.chrome ?? null }) };
}
