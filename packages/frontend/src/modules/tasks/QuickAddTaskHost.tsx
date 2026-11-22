// The quick-add task host the shell mounts: it waits for openQuickAddTask() and
// loads the sheet (QuickAddSheet) the first time it is asked for.

import { Suspense, useEffect, useState } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { OPEN_QUICK_ADD_TASK_EVENT, type QuickAddTarget } from "./openQuickAddTask";
import { onWindow } from "../../lib/globalEvents";

const QuickAddSheet = lazyWithReload(() => import("./QuickAddSheet"));

export default function QuickAddTask() {
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState<QuickAddTarget | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ into: QuickAddTarget | null } | undefined>).detail;
      setInto(detail?.into ?? null);
      setOpen(true);
    };
    return onWindow(OPEN_QUICK_ADD_TASK_EVENT, handler);
  }, []);
  return open ? <Suspense fallback={null}><QuickAddSheet into={into} onClose={() => setOpen(false)} /></Suspense> : null;
}
