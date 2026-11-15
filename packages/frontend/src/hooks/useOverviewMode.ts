// Overview (notes) mode — slimmed by the H4 store refactor.
//
// What used to live here moved out:
//   draft text/title/status + autosave/flush  → lib/data/draftActions.ts
//     (store-resident, so keystrokes re-render only draft subscribers)
//   overviewNodes/inbox/tag-count/tag-filter   → lib/appStore selectors
//   sidebar search                             → hooks/useOverviewSearch.ts
//   pane/view/search UI state                  → lib/appStore
//
// What remains: the node-switch draft reset, the pagehide flush, version
// history fetching and the wikilink opener (card extraction lives in
// modules/review). The mini-graph neighbours moved to NoteRelations (under the note body).

import { randomUUID } from "../lib/uuid";
import { useEffect, useState } from "react";
import { nodeNeedsBody } from "../lib/api";
import { drafts, noteWriter, reads } from "../lib/data";
import { t } from "../lib/i18n";
import { resolveWikilink } from "../lib/wikilinks";
import { blockLinkOutcome } from "../lib/blockHome";
import { useCapabilities } from "../lib/capabilities";
import { openTaskSheet } from "../modules";
import { resolveTaskRef, taskLineRange, taskRefById, type TaskRef } from "../lib/taskRefs";
import { setPendingCursor } from "../lib/cursorHandoff";
import { useAppSelector, setSelectedId, addToast, selectOverviewNodes, selectOverviewSelectedNode, useOnline, useAllNodes } from "../lib/appStore";
import { onPageHide } from "../lib/pageHide";

interface UseOverviewModeOptions {
  setMode: (mode: "notes" | "timeline") => void;
  /** Force the readable lens after a link-driven open so the target lands in its
   *  document view, never inheriting the source's structural lens (e.g. a canvas
   *  wikilink that would otherwise open in the empty Canvas lens). */
  setNotesView: (view: "editor" | "canvas" | "local-graph") => void;
  /** Called right before a wikilink follow switches selection — pushes the node
   *  we're leaving onto the nav back-stack so Back returns to it. */
  onBeforeNavigate?: () => void;
}

export function useOverviewMode({ setMode, setNotesView, onBeforeNavigate }: UseOverviewModeOptions) {
  const online = useOnline();
  const capabilities = useCapabilities(online);
  const dataNodes = useAllNodes();
  const overviewNodes = useAppSelector(selectOverviewNodes);
  const overviewSelectedNode = useAppSelector(selectOverviewSelectedNode);

  const [versionHistory, setVersionHistory] = useState<{ nodeId: string; versions: Array<{ id: string; title: string; markdown: string; changed_at: string; actor_name: string | null; actor_type: string | null }> } | null>(null);
  const nodeVersions = versionHistory?.nodeId === overviewSelectedNode?.id ? versionHistory?.versions ?? [] : [];

  // Reset draft when selected node changes — flushing the PREVIOUS node's
  // pending edit first (it used to be dropped on the floor with the timer).
  // Slim-bootstrap guard: while the selected node's body is still on the
  // server (nodeNeedsBody), do NOT seed the draft or the merge base from the
  // empty placeholder — a save from that state would WIPE the note. The
  // editor pane renders a loading placeholder until hydrateNode swaps the
  // full row in, which flips this flag and re-runs the seeding below.
  const selectedNeedsBody = nodeNeedsBody(overviewSelectedNode);

  useEffect(() => {
    drafts.reset(selectedNeedsBody ? null : overviewSelectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on id (+ the hydration flip): a data refresh for the SAME node must not clobber an in-progress draft
  }, [overviewSelectedNode?.id, selectedNeedsBody]);

  // Same note, newer row (another device, an agent, a merge): refresh an
  // editor that has no unsaved input (GAP-186). Runs after the reset above.
  useEffect(() => {
    drafts.applyRemote(overviewSelectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the row's text matters
  }, [overviewSelectedNode?.id, overviewSelectedNode?.markdown, overviewSelectedNode?.title]);

  // The page going away is the other silent-loss window: flush with
  // keepalive so the PATCH outlives the tab. pagehide covers close/navigate;
  // visibilitychange→hidden covers mobile app-switch (where pagehide may
  // never fire before the process is killed).
  useEffect(() => {
    return onPageHide(() => { void drafts.flush({ keepalive: true }); });
  }, []);

  useEffect(() => {
    if (!overviewSelectedNode || !online) { setVersionHistory(null); return; }
    // Stale-response guard (M13): a fast node switch leaves the previous node's
    // /versions fetch in flight; ignore its resolution so it can't overwrite the
    // current node's history.
    let cancelled = false;
    void reads.notes.versions(overviewSelectedNode.id)
      .then((v) => { if (!cancelled) setVersionHistory({ nodeId: overviewSelectedNode.id, versions: v }); })
      .catch(() => { if (!cancelled) setVersionHistory(null); });
    return () => { cancelled = true; };
  }, [overviewSelectedNode?.id, overviewSelectedNode?.updated_at, online]); // eslint-disable-line react-hooks/exhaustive-deps

  function openTask(task: TaskRef) {
    const host = task.task.hostId ? dataNodes.find((node) => node.id === task.task.hostId) : undefined;
    if (host) {
      const line = taskLineRange(host.markdown ?? "", task.title);
      if (line) setPendingCursor(host.id, line.start, line.end);
      onBeforeNavigate?.();
      setSelectedId(host.id);
      setMode("notes");
      setNotesView("editor");
      return;
    }
    openTaskSheet(task.id);
  }

  // Clicking a [[wikilink]] opens its target — and if the target doesn't
  // exist yet, CREATES it (the Obsidian beat: an unresolved link is a note
  // you haven't written, one click away). The new note is born linked: the
  // source already names it, so syncWikilinkEdges wires the backlink on the
  // next save. Create goes through the normal node API (evented, undoable).
  // `targetId`: the note the caller already resolved (the preview carries the
  // id it rendered) opens as-is; otherwise the label resolves here.
  // `fromId`: the note the link is written in, when that is not the open note
  // (a card on a whiteboard).
  // `blockId`: the link was `[[label#^blockId]]`; when its note no longer holds
  // that block, the note that does opens instead (lib/blockHome).
  async function openWikilink(label: string, targetId?: string | null, fromId?: string, blockId?: string) {
    // [[title]] resolves within the linking note's space (a tag is global):
    // a same-titled note in another space is a different note (lib/wikilinks).
    const from = (fromId ? dataNodes.find((node) => node.id === fromId) : undefined) ?? overviewSelectedNode;
    const fromSpace = from?.space_id ?? null;
    const target = (targetId ? dataNodes.find((node) => node.id === targetId) : undefined)
      ?? resolveWikilink(label, from, dataNodes);
    if (!target) {
      // A task is no note: a line's task opens its note on that line, a
      // standalone one opens on its own screen. Never created from a link.
      const task = (targetId ? taskRefById(targetId) : null) ?? resolveTaskRef(label);
      if (task) return openTask(task);
    }
    if (target) {
      const outcome = blockId ? await blockLinkOutcome(target, blockId, dataNodes) : null;
      const opened = outcome?.target ?? target;
      onBeforeNavigate?.(); // record where we came from for the Back stack
      setSelectedId(opened.id);
      setMode("notes");
      setNotesView("editor"); // land in the note body, not the source's lens
      // The paragraph was deleted: the note opens anyway; say so, and offer to bring it back.
      if (outcome?.deleted && blockId) {
        const canEdit = capabilities.canEdit(outcome.target);
        const { text } = outcome;
        void import("../lib/blockSafety").then(({ offerDeletedBlock }) => offerDeletedBlock(opened, blockId, text, canEdit));
      }
      return;
    }
    // Through the note writer: works offline too (queued), and a failure is
    // reported once by the writer.
    try {
      const { node: created } = await noteWriter.create({ id: randomUUID(), title: label.trim(), markdown: "", space_id: fromSpace });
      onBeforeNavigate?.(); // back-stack symmetry: created-from-link returns too
      setSelectedId(created.id);
      setMode("notes");
      setNotesView("editor"); // the just-created note opens ready to write
      addToast(t("Created “{title}” from a link", { title: created.title }), "success");
    } catch {
      // Reported by the writer.
    }
  }

  return {
    nodeVersions,
    overviewNodes,
    overviewSelectedNode,
    openWikilink,
  };
}
