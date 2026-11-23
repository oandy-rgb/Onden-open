import { api, type ContentNode } from "../api";
import { upsertAttribute, upsertNode } from "../localDb";
import type { InkKind } from "@onden/markdown/ink";
import { t } from "../i18n";
import { queuedWriteMessage } from "./writeErrors";
import { makeOnlineOperation } from "./onlineWrite";
import { makeWriteLifecycle, reconcileFields } from "./writeLifecycle";
import type { DataCtx } from "./types";
import type { RewindRequest, RunUndoResult } from "../history";
import { nodeOf } from "../nodeIndex";
import { announceDrawingRestored } from "../drawingChanges";
import type { RestoreVersionRequest, RewindResult, RewindUndoResult } from "@onden/contract";

export function makeNoteHistoryWriter(ctx: DataCtx) {
  const onlineOperation = makeOnlineOperation(ctx);
  const commit = makeWriteLifecycle(ctx);
  // Once acknowledged, retry only the result read. A failed GET must never
  // remint a restore operation and overwrite edits made after its commit.
  const awaitingResult = new Set<string>();
  /** Undefined means committed but not loaded; callers must retain their draft.
   * A retry of that operation reads current server state without restoring again. */
  async function restoreVersion(nodeId: string, versionId: string, { restoreTitle }: { restoreTitle: boolean }): Promise<ContentNode | undefined> {
    const path = `/api/nodes/${nodeId}/versions/${encodeURIComponent(versionId)}/restore`; // a version key has colons
    const body = JSON.stringify({ restore_title: restoreTitle } satisfies RestoreVersionRequest);
    // A different title choice is a different operation: never borrow the earlier one's acknowledgement.
    const operationKey = `${path}:${body}`;
    return onlineOperation(`node:${nodeId}`, t("Version restore needs a connection."), async (submit) => {
      const before = nodeOf(ctx.data, nodeId);
      let restored: ContentNode | undefined;
      if (!awaitingResult.has(operationKey)) {
        const acknowledged = await submit<ContentNode>(path, body);
        awaitingResult.add(operationKey);
        if ("id" in acknowledged && acknowledged.id === nodeId && typeof acknowledged.markdown === "string") restored = acknowledged;
      }
      try {
        restored ??= await api<ContentNode>(`/api/nodes/${nodeId}`);
        if (restored.id !== nodeId || typeof restored.markdown !== "string") throw new Error("Missing restored note");
      } catch {
        ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info");
        return undefined;
      }
      awaitingResult.delete(operationKey);
      try {
        const loaded = restored;
        ctx.setData((state) => ({ ...state, nodes: state.nodes.map((node) => node.id === nodeId ? reconcileFields(node, before ?? {}, loaded) : node) }));
        const current = nodeOf(ctx.data, nodeId);
        if (current) await upsertNode(current);
      } catch { ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error"); }
      return nodeOf(ctx.data, nodeId) ?? restored;
    });
  }
  /** Put one of a note's drawings back as it was after a save listed in its History (`eventId`). The server
   *  writes only that drawing's own attribute; the local copy then holds what it stored. Needs a connection;
   *  true once the server accepted it (a failed local copy only says so, the change stands). */
  async function restoreInkVersion(nodeId: string, kind: InkKind, eventId: string): Promise<boolean> {
    const path = `/api/nodes/${nodeId}/ink-versions/${encodeURIComponent(eventId)}/restore?kind=${kind}`;
    return onlineOperation(`node:${nodeId}`, t("Version restore needs a connection."), async (submit) => {
      const saved = await submit<{ key: string; value: string }>(path);
      if ("deduped" in saved) { announceDrawingRestored(nodeId); return true; }
      try { await upsertAttribute(nodeId, saved.key, saved.value, "text", false, "ui"); }
      catch { ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error"); }
      // The surface showing this drawing loads the restored version (what it shows is the one before).
      announceDrawingRestored(nodeId);
      return true;
    });
  }
  /** One History action whose answer is the server's own report (which notes
   *  it changed). `undefined`: the server applied it but the report was lost
   *  (a retried request is answered "deduped", without the counts), so the
   *  caller re-reads what it shows instead of guessing numbers. A refusal
   *  throws, already reported once. */
  async function historyAction<T>(resource: string, offlineMessage: string, path: string, body: unknown): Promise<T | undefined> {
    return onlineOperation(resource, offlineMessage, async (submit) => {
      const answer = await submit<T>(path, JSON.stringify(body));
      if (typeof answer === "object" && answer !== null && "deduped" in answer) {
        ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info");
        return undefined;
      }
      return answer as T;
    });
  }
  /** Roll the chosen notes of an agent run back to before it (later human edits stay; lines both
   *  sides changed go to the inbox). */
  const undoAgentRun = (runId: string, nodeIds: string[]) =>
    historyAction<RunUndoResult>(`agent-run:${runId}`, t("Undoing needs a connection."), `/api/history/agent-runs/${encodeURIComponent(runId)}/undo`, { node_ids: nodeIds });
  /** Take the agent's changes back (the undo of an undo). */
  const redoAgentRun = (runId: string, nodeIds: string[]) =>
    historyAction<RunUndoResult>(`agent-run:${runId}`, t("Undoing needs a connection."), `/api/history/agent-runs/${encodeURIComponent(runId)}/redo`, { node_ids: nodeIds });
  /** 「還原到這時」: put the chosen notes back as they were at `request.t`. */
  const rewindWorkspace = (request: RewindRequest) =>
    historyAction<RewindResult>("history:rewind", t("Restoring needs a connection."), "/api/history/rewind", request);
  const undoRewind = (rewindId: string, nodeIds: string[]) =>
    historyAction<RewindUndoResult>(`rewind:${rewindId}`, t("Undoing needs a connection."), `/api/history/rewinds/${encodeURIComponent(rewindId)}/undo`, { node_ids: nodeIds });

  async function undelete(id: string) {
    const result = await commit(`node:${id}`, { method: "POST", path: `/api/nodes/${id}/undelete`, body: null });
    // Server restores descendants too. Only its refreshed projection can tell
    // us the complete result; a queued intent is not yet a restored subtree.
    if (result.status === "synced") {
      try { await ctx.refresh(); }
      catch { ctx.addToast(t("The change is saved. Refresh to load the latest details."), "info"); }
    } else ctx.addToast(queuedWriteMessage(), "info"); // nothing else changes on screen: say it is kept, so the person does not press again
    return result;
  }
  return { restoreVersion, restoreInkVersion, undelete, undoAgentRun, redoAgentRun, rewindWorkspace, undoRewind };
}
