import type { ContentNode, Tag } from "../api";
import { upsertNode, removeNode } from "../localDb";
import { randomUUID } from "../uuid";
import { t } from "../i18n";
import { addNodeTag, dropNodeTag, patchNode } from "./storeOps";
import { optimisticFields } from "./optimisticFields";
import { makeWriteLifecycle } from "./writeLifecycle";
import { reportWriteFailure, WriteActionError } from "./writeErrors";
import type { DataCtx } from "./types";
import { slugify } from "@onden/markdown";
import { nodeHasTag } from "../nodeTags";
import { nodeOf } from "../nodeIndex";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

export function makeTagWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);

  function membership(nodeId: string, tagId: string, apply: boolean) {
    const node = nodeOf(ctx.data, nodeId);
    const hadClass = node?.class_tag_ids?.includes(tagId) ?? false;
    const hadLabel = node?.label_tag_ids?.includes(tagId) ?? false;
    const after = (apply ? addNodeTag(ctx.data, nodeId, tagId) : dropNodeTag(ctx.data, nodeId, tagId)).nodes.find((row) => row.id === nodeId);
    const settle = optimisticFields(`membership:${nodeId}:${tagId}`, { class: hadClass, label: hadLabel }, {
      class: after?.class_tag_ids?.includes(tagId) ?? false,
      label: after?.label_tag_ids?.includes(tagId) ?? false,
    });
    ctx.setData((state) => apply ? addNodeTag(state, nodeId, tagId) : dropNodeTag(state, nodeId, tagId));
    return commit(`node:${nodeId}`, {
      method: apply ? "PUT" : "DELETE", path: `/api/nodes/${nodeId}/tags/${tagId}`, body: apply ? "{}" : null,
    }, {
      mirror: async () => {
        const current = nodeOf(ctx.data, nodeId);
        if (current) await upsertNode(current);
      },
      accepted: () => { settle(true); },
      unconfirmed: () => { settle(true); },
      rejected: () => {
        const { replacement } = settle(false);
        if (!Object.hasOwn(replacement, "class")) return;
        ctx.setData((state) => ({
        ...state, nodes: state.nodes.map((row) => {
          if (row.id !== nodeId) return row;
          const present = nodeHasTag(row, tagId);
          if (present !== apply) return row;
          const restore = (ids: string[] = [], had: boolean) => [...ids.filter((id) => id !== tagId), ...(had ? [tagId] : [])];
          return { ...row, class_tag_ids: restore(row.class_tag_ids, replacement.class ?? false), label_tag_ids: restore(row.label_tag_ids, replacement.label ?? false) };
        }),
      }));
      },
    });
  }

  /** Create a plain tag (no schema) named `name` — the same tag `#name` in
   *  Quick capture creates, allowed to anyone who can write somewhere (editors too).
   *  The id is minted here and kept by POST /api/tags, so the optimistic tag
   *  stays put; it doubles as the Idempotency-Key for a queued replay.
   *  `parentId`: under that tag (the server refuses a note or a function).
   *  `queued`: persisted in the offline queue, not yet accepted by the server.
   *  A refusal (409 name taken, 403 read-only) rolls the tag back and throws.
   *  A name with "/" is refused (reported, thrown) before anything is written:
   *  it is a path, which only a block's `{a/b}` (or the tag page's parent) creates (resolve-path, online,
   *  server-minted ids — nothing this queued, client-id write can reconcile). */
  async function create(name: string, { parentId = null }: { parentId?: string | null } = {}): Promise<{ id: string; queued: boolean }> {
    if (name.includes("/")) {
      const error = new WriteActionError(t("A tag name can't contain “/”. To make a nested tag, create it first, then pick its parent tag in “Edit structure” on its tag page."));
      reportWriteFailure(error, ctx.addToast);
      throw error;
    }
    const id = randomUUID();
    const node: ContentNode = { id, title: name, slug: `tag-${slugify(name)}`, markdown: "", source_type: "manual", node_type: TAG_NODE_TYPE, ...(parentId ? { parent_id: parentId } : {}) };
    const tag: Tag = { id, name, color: "#888888", schema_id: null, ...(parentId ? { parent_id: parentId } : {}) };
    ctx.setData((state) => ({ ...state, nodes: [...state.nodes, node], tags: [...(state.tags ?? []), tag] }));
    const result = await commit(`node:${id}`, { method: "POST", path: "/api/tags", body: JSON.stringify(parentId ? { id, name, parent_id: parentId } : { id, name }), idemKey: id }, {
      mirror: async () => {
        const current = nodeOf(ctx.data, id);
        if (current) await upsertNode(current);
        else await removeNode(id);
      },
      rejected: () => ctx.setData((state) => ({ ...state, nodes: state.nodes.filter((row) => row.id !== id), tags: (state.tags ?? []).filter((row) => row.id !== id) })),
    });
    if (result.status === "synced") {
      // Refresh failure is a read failure after a successful write.
      void ctx.refresh().catch(() => ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info"));
    }
    return { id, queued: result.status === "queued" };
  }

  /** Hide or show a tag (「隱藏標籤」, D104 — only tags can be hidden). The
   *  same node update every edit goes through (PATCH /api/nodes/:id
   *  { hidden }): one event, synced, undoable from history. The tag keeps
   *  working; lists, chips and suggestions leave it out (lib/nodeTags.ts
   *  isTagShown). A refusal puts the flag back and throws. */
  async function setHidden(tagId: string, hidden: boolean): Promise<{ queued: boolean }> {
    const before = (ctx.data.tags ?? []).find((tag) => tag.id === tagId)?.hidden
      ?? nodeOf(ctx.data, tagId)?.hidden ?? false;
    ctx.setData((state) => patchNode(state, tagId, { hidden }));
    const result = await commit(`node:${tagId}`, { method: "PATCH", path: `/api/nodes/${tagId}`, body: JSON.stringify({ hidden }) }, {
      mirror: async () => {
        const current = nodeOf(ctx.data, tagId);
        if (current) await upsertNode(current);
      },
      rejected: () => ctx.setData((state) => patchNode(state, tagId, { hidden: before })),
    });
    return { queued: result.status === "queued" };
  }

  return {
    create, setHidden,
    apply: (nodeId: string, tagId: string) => membership(nodeId, tagId, true),
    remove: (nodeId: string, tagId: string) => membership(nodeId, tagId, false),
  };
}
