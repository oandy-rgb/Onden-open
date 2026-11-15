// The task sheet host the shell mounts: it waits for openTaskSheet(), then shows the task in the
// same TaskSheet and board actions the Tasks page uses. A task that is no longer there says so once.

import { Suspense, useEffect, useState } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { onWindow } from "../../lib/globalEvents";
import { OPEN_TASK_SHEET_EVENT } from "./openTaskSheet";

const TaskSheetOpener = lazyWithReload(() => import("./TaskSheetOpener"));

type Props = {
  online: boolean;
  /** Open a note (a task's own body, its note). */
  onSelectNode: (id: string) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
};

export default function TaskSheetHost(props: Props) {
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => onWindow(OPEN_TASK_SHEET_EVENT, (event) => {
    const detail = (event as CustomEvent<{ taskId: string } | undefined>).detail;
    if (detail?.taskId) setTaskId(detail.taskId);
  }), []);
  if (!taskId) return null;
  return <Suspense fallback={null}><TaskSheetOpener {...props} taskId={taskId} onClose={() => setTaskId(null)} /></Suspense>;
}
