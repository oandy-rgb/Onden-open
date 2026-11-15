import { useEffect, useRef, useState } from "react";
import { addToast, getAppState, useAppSelector } from "../lib/appStore";
import { prepareCanvasExport } from "../lib/canvasExport";
import { writeErrors } from "../lib/data";
import { downloadBlob } from "../lib/download";

/** One pending download per open board; late reads cannot download or report
 * errors after leaving that board, workspace, or readable-content lifetime. */
export function useCanvasExport() {
  const canvasId = useAppSelector(state => state.activeCanvas?.id);
  const workspaceId = useAppSelector(state => state.data.workspace.id);
  const membershipGated = useAppSelector(state => state.membershipGated);
  const lifetime = useRef({ active: true });
  const pending = useRef(false);
  const [isExporting, setIsExporting] = useState(false);
  useEffect(() => {
    const scope = { active: true };
    lifetime.current = scope;
    pending.current = false;
    setIsExporting(false);
    return () => { scope.active = false; };
  }, [canvasId, workspaceId, membershipGated]);

  async function exportBoard() {
    const state = getAppState();
    if (pending.current || state.membershipGated || !state.activeCanvas) return;
    const scope = lifetime.current;
    const current = () => {
      const now = getAppState();
      return scope.active && lifetime.current === scope && !now.membershipGated
        && now.activeCanvas?.id === state.activeCanvas?.id && now.data.workspace.id === state.data.workspace.id;
    };
    pending.current = true;
    setIsExporting(true);
    try {
      const prepared = await prepareCanvasExport(state.activeCanvas, state.data.nodes, state.data.edges);
      if (!current()) return;
      if (prepared.ink) {
        const { canvasArchive } = await import("../lib/canvasArchive");
        const zip = await canvasArchive({ ...prepared, ink: prepared.ink });
        if (!current()) return;
        downloadBlob(zip, prepared.archiveName);
      } else {
        downloadBlob(new Blob([JSON.stringify(prepared.canvas, null, 2)], { type: "application/json" }), prepared.filename);
      }
    } catch (error) {
      if (current()) writeErrors.report(error, addToast);
    } finally {
      if (scope.active && lifetime.current === scope) {
        pending.current = false;
        setIsExporting(false);
      }
    }
  }

  return { exportBoard, isExporting };
}
