// UI-facing note actions. Ordinary note writes delegate their save lifecycle
// and error reporting to noteWriter; these adapters supply success messages.
// History and compound extraction compose domain operations with explicit results.

import type { InkKind } from "@onden/markdown/ink";
import type { ContentNode } from "../api";
import { t } from "../i18n";
import type { DataCtx } from "./types";
import { makeNoteWriter } from "./noteWriter";
import { makeTagWriter } from "./tagWriter";
import { makeWorkspaceWriter } from "./workspaceWriter";
import { makeNoteHistoryWriter } from "./noteHistoryWriter";
import { runBackgroundWrite } from "./backgroundWrite";
import { reservedTagIds } from "../systemNodes";
import { SERVER_ERROR_MESSAGES } from "../serverErrors";
import { nodeOf } from "../nodeIndex";

export function makeNodeMutations(ctx: DataCtx) {
  // online (and data) are read OFF ctx at call time, not destructured at
  // factory time: the H4 store builds ctx with live getters and creates the
  // mutation objects once at module scope, so a value captured here would
  // freeze the boot-time offline state forever.
  const { addToast } = ctx;

  const writer = makeNoteWriter(ctx);
  const tags = makeTagWriter(ctx);
  const workspace = makeWorkspaceWriter(ctx);
  const history = makeNoteHistoryWriter(ctx);

  async function createNode(title: string, _kind: "markdown", _nodeCount: number, parentId?: string | null, spaceId?: string | null): Promise<ContentNode | null> {
    // The writer owns error reporting; creation callers use null to keep their UI open.
    const result = await writer.create({ title, ...(parentId ? { parent_id: parentId } : {}), ...(spaceId && !parentId ? { space_id: spaceId } : {}) }).catch(() => null);
    if (!result) return null;
    addToast(t(result.status === "synced" ? '"{title}" created' : '"{title}" saved locally', { title }));
    return result.node;
  }

  /** Resolves true once the server accepted the delete or it is durably
   *  queued; false when it was refused (the writer has already reported why). */
  async function deleteNode(id: string, title?: string): Promise<boolean> {
    // Every delete surface (menus, rows, shortcuts) ends here: a reserved tag
    // is refused before the optimistic drop instead of vanishing until the 409.
    if (reservedTagIds(ctx.data.tags).has(id)) {
      addToast(t(SERVER_ERROR_MESSAGES.reserved_tag!), "error");
      return false;
    }
    const result = await writer.remove(id).catch(() => null);
    if (!result) return false;
    if (result.status === "queued") {
      addToast(t('"{title}" deleted locally', { title: title ?? t("Node") }), "info");
      return true;
    }
    addToast(t('"{title}" deleted', { title: title ?? t("Node") }), "info", {
      label: t("Undo"),
      onClick: () => runBackgroundWrite(history.undelete(id)),
    });
    return true;
  }

  /** True once the server accepted the undelete (the note and its subtree are back).
   *  False when it was refused or only queued; the writer has already reported why. */
  async function undeleteNode(id: string): Promise<boolean> {
    const result = await history.undelete(id).catch(() => null);
    return result?.status === "synced";
  }

  async function duplicateNode(node: ContentNode) {
    const result = await writer.duplicate(node).catch(() => null);
    if (result) addToast(t(result.status === "synced" ? '"{title}" duplicated' : '"{title}" saved locally', { title: result.node.title }));
  }

  /** True means the server or durable local queue accepted the rename.
   * False keeps the rename form open; the writer has already reported failure. */
  async function renameNode(id: string, newTitle: string): Promise<boolean> {
    const title = newTitle.trim();
    if (!title) return false;
    // The same name again (the form closed without a change) is no rename:
    // nothing is written, so the note gets no history point.
    if (nodeOf(ctx.data, id)?.title === title) return true;
    const result = await writer.patch(id, { title }).catch(() => null);
    if (result) addToast(t(result.status === "synced" ? "Renamed" : '"{title}" saved locally', { title }));
    return result !== null;
  }

  async function setHomeNode(id: string | null) {
    const result = await workspace.setHome(id);
    addToast(result.status === "queued" ? t("Website changes saved locally") : id ? t("Home page set") : t("Home page cleared"));
  }

  async function assignToGroup(nodeId: string, parentId: string | null) {
    await writer.patch(nodeId, { parent_id: parentId }).catch(() => null);
  }

  async function promoteNode(id: string, title?: string) {
    const result = await writer.promote(id).catch(() => null);
    if (result) addToast(t('"{title}" is shown again', { title: title ?? t("Node") }));
  }

  /** `restoreTitle: false` brings back the text only; the note keeps its title. */
  async function restoreVersion(nodeId: string, versionId: string, choice: { restoreTitle: boolean }): Promise<ContentNode | undefined> {
    const restored = await history.restoreVersion(nodeId, versionId, choice);
    if (restored) addToast(t("Version restored"));
    return restored;
  }

  const restoreInkVersion = (nodeId: string, kind: InkKind, eventId: string) => history.restoreInkVersion(nodeId, kind, eventId);

  // Creation and tag application are separate accepted changes. Return the
  // existing note on partial success so retrying extraction cannot duplicate it.
  async function extractToEntity(title: string, classTagId: string): Promise<ContentNode | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const created = await writer.create({ title: trimmed }).catch(() => null);
    if (!created) return null;
    try {
      const tagged = await tags.apply(created.node.id, classTagId);
      addToast(t(created.status === "queued" || tagged.status === "queued" ? '"{trimmed}" extracted locally' : 'Extracted "{trimmed}"', { trimmed }));
    } catch {
      addToast(t("The note was created, but its tag could not be applied. Add the tag to this note after retrying sync."), "info");
    }
    return nodeOf(ctx.data, created.node.id) ?? created.node;
  }

  return { createNode, deleteNode, duplicateNode, renameNode, setHomeNode, assignToGroup, promoteNode, restoreVersion, restoreInkVersion, undeleteNode, extractToEntity };
}
