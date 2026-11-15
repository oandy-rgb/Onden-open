import type { ContentNode } from "../api";
import { upsertNode, removeNode, upsertAttribute, removeAttribute } from "../localDb";
import { randomUUID } from "../uuid";
import { t } from "../i18n";
import { WriteActionError, reportWriteFailure, writeFailureMessage } from "./writeErrors";
import { addNode, addNodeTag, dropNode, dropNodeAttr, patchNode, setNodeAttr } from "./storeOps";
import { type WriteRequest, type WriteResult } from "./writeQueue";
import { preserveDirectRejection } from "./writeRecovery";
import { optimisticFields } from "./optimisticFields";
import { makeWriteLifecycle } from "./writeLifecycle";
import type { DataCtx } from "./types";
import { clampNoteTitle, NODE_TITLE_MAX, KEPT_OFF_BY_PARENT_ATTR_KEY, newNoteSiteDefault, noteSizeProblem, PUBLISHED_ATTR_KEY, slugify } from "@onden/markdown";
import { SERVER_ERROR_MESSAGES } from "../serverErrors";
import { nodeOf } from "../nodeIndex";
import { settleNodeToServer } from "./serverTruth";
import { isNote } from "@onden/markdown/contract";

export type NotePatch = Partial<Pick<ContentNode, "title" | "markdown" | "parent_id" | "hidden" | "slug" | "presentation" | "sort_order">>;
type CursorState = { anchor: number; head: number };
type NoteWriteOptions = { cursorState?: CursorState; baseMarkdown?: string; keepalive?: boolean;
  /** The editor's own edits since the base (lib/editorChangeLog.ts); the server uses them to move block anchors. */
  bodyChange?: { changes: unknown; device: string } };
/** A note's first value for one attribute, written with the note itself. */
export type InitialAttribute = { key: string; value: string; value_type?: "text" | "number" | "date" | "bool" | "node_ref"; is_inheritable?: boolean };
/** `id` lets a caller retry the same creation: it doubles as the Idempotency-Key
 *  so the server never creates a second note (quick capture keeps its ids
 *  across a refused or lost attempt). `tagIds` and `attributes` are applied in
 *  the SAME server request and transaction: the note never exists without them
 *  (a handwriting page without its kind, a collection row without its tag), and a refusal
 *  of any of them refuses the whole creation. */
export type CreateNote = {
  title: string; markdown?: string; node_type?: ContentNode["node_type"]; id?: string; parent_id?: string | null;
  /** Provenance: "ai" for a saved answer. Defaults to "manual". */
  source_type?: "manual" | "ai";
  tagIds?: string[]; attributes?: InitialAttribute[];
  /** A top-level note's space (default: the creator's personal space). */
  space_id?: string | null;
  /** The caller opens the existing note when its id is already taken (409
   *  `note_exists`): that answer is neither shown nor kept in recovery. */
  existingNoteIsFine?: true;
};
/** `deduped`: the server had already committed this request's Idempotency-Key
 *  (an earlier attempt, or another device creating the same deterministic id)
 *  and answered without a row — `node` is then this device's optimistic copy,
 *  not the server's; re-read it before trusting its fields. */
type NoteResult = { status: WriteResult<ContentNode>["status"]; node: ContentNode; deduped?: true };

/** Owns the note-write lifecycle: optimistic state, local mirror, durable
 * submission, server reconciliation and rollback. Callers express note intent
 * and show success only after this resolves. Failures are reported here;
 * rejection remains observable to an editor which must retain its dirty draft. */
export function makeNoteWriter(ctx: DataCtx) {
  const submit = makeWriteLifecycle(ctx);

  /** The size caps the server holds every note to (@onden/markdown
   *  noteLimits.ts), checked before anything is shown or queued: a queued
   *  write over a cap would be refused on every sync. */
  function sizeRefusal(note: { title?: string | null; markdown?: string | null }): WriteActionError | null {
    const problem = noteSizeProblem(note);
    return problem ? new WriteActionError(t(SERVER_ERROR_MESSAGES[problem]!)) : null;
  }

  function assertFits(note: { title?: string | null; markdown?: string | null }) {
    const error = sizeRefusal(note);
    if (!error) return;
    reportWriteFailure(error, ctx.addToast);
    throw error;
  }

  /** The app itself refuses a save of typed text before anything is sent. The server's refusals reach the recovery
   *  panel through writeQueue (preserveDirectRejection); this one never gets there, so it is kept here, the same way,
   *  before the error reaches the editor: opening another note or reloading must not lose the text. */
  async function refuseUnsent(error: WriteActionError, request: WriteRequest): Promise<never> {
    try { await preserveDirectRejection({ ...request, idemKey: randomUUID() }, writeFailureMessage(error), error); }
    catch (storageError) { reportWriteFailure(storageError, ctx.addToast); }
    // The recovery entry is the notice when it holds text; otherwise this is the only one.
    reportWriteFailure(error, ctx.addToast);
    throw error;
  }

  function reconcile(id: string, expected: ContentNode, replacement: Partial<ContentNode>) {
    ctx.setData((state) => {
      const node = state.nodes.find(row => row.id === id);
      if (!node) return state;
      const changes: Partial<ContentNode> = {};
      for (const key of Object.keys(replacement) as (keyof ContentNode)[]) {
        if (node[key] === expected[key]) Object.assign(changes, { [key]: replacement[key] });
      }
      return patchNode(state, id, changes);
    });
  }

  async function commit(id: string, optimistic: ContentNode, request: WriteRequest, rollback: () => void, options: { deleted?: boolean; created?: boolean; settle?: ReturnType<typeof optimisticFields<ContentNode>>; changedFields?: string[]; mirrorAttributes?: InitialAttribute[] } = {}): Promise<NoteResult> {
    const { deleted = false, created = false, settle, changedFields = [], mirrorAttributes = [] } = options;
    let serverNode: ContentNode | null = null;
    let deduped = false;
    const result = await submit<ContentNode>(`node:${id}`, request, {
      destructive: deleted,
      mirror: async () => {
        const current = nodeOf(ctx.data, id);
        if (current && !deleted) {
          await upsertNode(current);
          for (const a of mirrorAttributes) await upsertAttribute(id, a.key, a.value, a.value_type ?? "text", a.is_inheritable ?? false, "ui");
        } else if (deleted || created) await removeNode(id);
      },
      accepted: (saved) => {
        deduped = saved.status === "synced" && (saved.value as { deduped?: boolean } | null)?.deduped === true;
        if (saved.status === "synced" && saved.value?.id === id) {
          // `noop`: the server found nothing to change and wrote nothing (no
          // history point); the row it returns is the note as it is.
          serverNode = saved.value;
          delete (serverNode as { noop?: true }).noop;
          // A create answers with the note's place on the site as stored: settle the drawing on it (the parent
          // this device drew from may have changed since). Local copy too.
          if (created && serverNode.attrs) settleSiteAttributes(id, serverNode.attrs);
          if (!deleted) {
            const unchanged = { ...serverNode };
            for (const key of changedFields as (keyof ContentNode)[]) {
              // Patch fields are reconciled by the journal below; metadata can
              // still be merged using the existing value guard.
              delete unchanged[key];
            }
            reconcile(id, optimistic, unchanged);
          }
        }
        if (settle) {
          const { expected, replacement } = settle(true, serverNode ?? {});
          reconcile(id, expected as ContentNode, replacement);
        }
      },
      rejected: async () => {
        if (settle) {
          const { expected, replacement } = settle(false);
          reconcile(id, expected as ContentNode, replacement);
        } else rollback();
        // A refused move or delete: what I remember may not be what the server has (it may be gone already).
        if (deleted || changedFields.some((key) => key === "parent_id")) await settleNodeToServer(id, ctx.setData);
      },
      unconfirmed: () => { settle?.(true); },
    });
    return { status: result.status, node: serverNode ?? optimistic, ...(deduped ? { deduped: true as const } : {}) };
  }

  // The server has accepted the create: a local-copy failure here does not undo that, and the next sync repairs the copy.
  const mirrorQuietly = (write: Promise<unknown>) => { void write.catch(() => {}); };

  /** Make the note's site attributes (`_published`, the inherited mark) what the server says, drawn and mirrored. */
  function settleSiteAttributes(id: string, stored: Record<string, string>) {
    for (const key of [PUBLISHED_ATTR_KEY, KEPT_OFF_BY_PARENT_ATTR_KEY]) {
      const current = nodeOf(ctx.data, id)?.attrs?.[key];
      const value = stored[key];
      if (value === undefined) {
        if (current === undefined) continue;
        ctx.setData((state) => dropNodeAttr(state, id, key));
        mirrorQuietly(removeAttribute(id, key));
      } else {
        if (current !== value) ctx.setData((state) => setNodeAttr(state, id, key, value));
        mirrorQuietly(upsertAttribute(id, key, value, "text", false, "derived")); // as the server stores it
      }
    }
  }

  async function create(input: CreateNote): Promise<NoteResult> {
    assertFits(input);
    const node: ContentNode = {
      id: input.id ?? randomUUID(), title: input.title, markdown: input.markdown ?? "",
      slug: slugify(input.title),
      source_type: input.source_type ?? "manual", node_type: input.node_type ?? "content",
      // Newest among its siblings until the server's own time replaces it
      // (lib/childOrder: equal sort_order sorts by creation).
      created_at: new Date().toISOString(),
      ...(input.parent_id !== undefined ? { parent_id: input.parent_id } : {}),
      ...(input.space_id ? { space_id: input.space_id } : {}),
    };
    const tagIds = input.tagIds ?? [];
    const attributes = input.attributes ?? [];
    const predictedSiteDefault = (state: typeof ctx.data) =>
      newNoteSiteDefault(node.parent_id ? state.nodes.find((row) => row.id === node.parent_id)?.attrs : undefined) ?? {};
    const siteDefaultAttributes = Object.entries(predictedSiteDefault(ctx.data)).map(([key, value]) => ({ key, value }));
    ctx.setData((state) => {
      if (state.nodes.some((row) => row.id === node.id)) return state;
      let next = addNode(state, node);
      for (const tagId of tagIds) next = addNodeTag(next, node.id, tagId);
      for (const a of attributes) next = setNodeAttr(next, node.id, a.key, a.value);
      // The server gives a note made under a kept-off note the same default (backend siteDefault.ts); drawn now so
      // an offline note does not look published until it syncs. Not sent: the server decides, from the parent it has.
      for (const [key, value] of Object.entries(predictedSiteDefault(next))) next = setNodeAttr(next, node.id, key, value);
      return next;
    });
    return commit(node.id, node, {
      method: "POST", path: "/api/nodes",
      body: JSON.stringify({
        id: node.id, title: node.title, markdown: node.markdown, source_type: node.source_type, node_type: node.node_type,
        ...(input.parent_id !== undefined ? { parent_id: input.parent_id } : {}),
        ...(input.space_id ? { space_id: input.space_id } : {}),
        ...(tagIds.length ? { tag_ids: tagIds } : {}),
        ...(attributes.length ? { attributes } : {}),
      }),
      idemKey: input.id ?? null,
      ...(input.existingNoteIsFine ? { existingNoteIsFine: true as const } : {}),
    }, () => ctx.setData((state) => dropNode(state, node.id)), { created: true, mirrorAttributes: [...attributes, ...siteDefaultAttributes] });
  }

  async function duplicate(source: ContentNode): Promise<NoteResult> {
    if (!isNote(source)) {
      const error = new WriteActionError(t("Only notes can be duplicated."));
      reportWriteFailure(error, ctx.addToast);
      throw error;
    }
    // The server's copy title (services/noteDuplicate.ts): it fits the cap.
    const title = `${clampNoteTitle(source.title, NODE_TITLE_MAX - " (Copy)".length)} (Copy)`;
    const node: ContentNode = {
      id: randomUUID(), title, markdown: source.markdown,
      slug: slugify(title),
      source_type: "manual", node_type: "content", parent_id: source.parent_id ?? null,
    };
    ctx.setData(state => addNode(state, node));
    return commit(node.id, node, {
      method: "POST", path: `/api/nodes/${source.id}/duplicate`,
      body: JSON.stringify({ id: node.id }),
    }, () => ctx.setData(state => dropNode(state, node.id)), { created: true });
  }

  async function change(id: string, changes: NotePatch, options: NoteWriteOptions = {}, promote = false): Promise<NoteResult> {
    const request: WriteRequest = {
      method: promote ? "POST" : "PATCH", path: `/api/nodes/${id}${promote ? "/promote" : ""}`,
      body: promote ? null : JSON.stringify({ ...changes, cursor_state: options.cursorState, base_markdown: options.baseMarkdown, ...(options.bodyChange ? { body_change: options.bodyChange } : {}) }),
      init: { keepalive: options.keepalive },
    };
    const previous = nodeOf(ctx.data, id);
    if (!previous) {
      return refuseUnsent(new WriteActionError(t("This note is no longer available. Keep your draft and reopen the note.")), request);
    }
    const tooBig = sizeRefusal(changes);
    if (tooBig) return refuseUnsent(tooBig, request);
    if (changes.parent_id === id) {
      // A note under itself is nothing the server keeps (it reads it as "top level"): not drawn, not sent.
      const error = new WriteActionError(t(SERVER_ERROR_MESSAGES.parent_cycle!));
      reportWriteFailure(error, ctx.addToast);
      throw error;
    }
    const settle = optimisticFields<ContentNode>(`node:${id}`, previous, changes);
    const optimistic = { ...previous, ...changes };
    ctx.setData((state) => patchNode(state, id, changes));
    const before = Object.fromEntries(Object.keys(changes).map((key) => [key, previous[key as keyof ContentNode]]));
    return commit(id, optimistic, request, () => reconcile(id, optimistic, before), { settle, changedFields: Object.keys(changes) });
  }

  async function remove(id: string): Promise<NoteResult | null> {
    const previous = nodeOf(ctx.data, id);
    if (!previous) return null;
    const edges = ctx.data.edges.filter((edge) => edge.source_node_id === id || edge.target_node_id === id);
    const tasks = ctx.data.tasks.filter((task) => task.node_id === id || task.id === id);
    // dropNode also drops the node's tag row and pointers: a refused delete restores them too.
    const tags = ctx.data.tags?.filter((tag) => tag.id === id) ?? [];
    const pointers = ctx.data.pointers?.filter((p) => p.parent_id === id || p.target_id === id) ?? [];
    ctx.setData((state) => dropNode(state, id));
    return commit(id, previous, { method: "DELETE", path: `/api/nodes/${id}`, body: null }, () => {
      ctx.setData((state) => ({
        ...state,
        nodes: state.nodes.some((node) => node.id === id) ? state.nodes : [...state.nodes, previous],
        edges: [...state.edges, ...edges.filter((edge) => !state.edges.some((current) => current.id === edge.id))],
        tasks: [...state.tasks, ...tasks.filter((task) => !state.tasks.some((current) => current.id === task.id))],
        ...(state.tags && tags.length ? { tags: [...state.tags, ...tags.filter((tag) => !state.tags!.some((current) => current.id === tag.id))] } : {}),
        ...(state.pointers && pointers.length ? { pointers: [...state.pointers, ...pointers.filter((p) => !state.pointers!.some((current) => current.id === p.id))] } : {}),
      }));
    }, { deleted: true });
  }

  return {
    create, duplicate, remove,
    patch: (id: string, changes: NotePatch, options?: NoteWriteOptions) => change(id, changes, options),
    promote: (id: string) => change(id, { hidden: false }, undefined, true),
  };
}
