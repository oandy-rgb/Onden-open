import { addToast } from "../lib/appStore";
import { nodeActions, taskWriter, writeErrors } from "../lib/data";
import { useEffect, useRef, type MouseEvent } from "react";
import type { ContentNode } from "../lib/api";
import type { CtxMenu } from "../lib/ctxMenu";

// A3 of the BuilderApp decomposition: the handlers that need the shell's React
// state — the task form, the sidebar's rename form and
// opening the context menu. A note's lifecycle actions themselves (delete,
// duplicate, hide, promote, …) are lib/data's `nodeActions` (D18); callers
// use those directly.

type Params = {
  selectedNode: ContentNode | null;
  taskTitle: string;
  setTaskTitle: (title: string) => void;
  renamingNodeId: string | null;
  renameDraft: string;
  setRenamingNodeId: (id: string | null) => void;
  setCtxMenu: (menu: CtxMenu | null) => void;
};

export function useNodeLifecycle({
  selectedNode,
  taskTitle,
  setTaskTitle,
  renamingNodeId,
  renameDraft,
  setRenamingNodeId,
  setCtxMenu,
}: Params) {
  const renameForm = useRef({ id: renamingNodeId, draft: renameDraft });
  useEffect(() => { renameForm.current = { id: renamingNodeId, draft: renameDraft }; }, [renamingNodeId, renameDraft]);
  const renamesInFlight = useRef(new Set<string>());
  async function addTask() {
    if (!selectedNode || !taskTitle.trim()) return;
    try {
      await taskWriter.create(selectedNode.id, taskTitle);
      setTaskTitle("");
    } catch { /* the writer has already reported the failure */ }
  }

  async function renameNode(id: string, newTitle: string) {
    // Enter followed by blur can submit the same form twice. A result may also
    // arrive after typing more or opening another rename form; keep that input.
    const key = JSON.stringify([id, newTitle]);
    if (renamesInFlight.current.has(key)) return;
    renamesInFlight.current.add(key);
    try {
      const accepted = await nodeActions.rename(id, newTitle);
      const current = renameForm.current;
      if (accepted && current.id === id && current.draft === newTitle) setRenamingNodeId(null);
    } catch (error) { writeErrors.report(error, addToast); }
    finally { renamesInFlight.current.delete(key); }
  }

  function openCtxMenu(e: MouseEvent, menu: CtxMenu) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu(menu);
  }

  return {
    addTask,
    renameNode,
    openCtxMenu,
  };
}
