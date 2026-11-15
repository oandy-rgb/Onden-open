// The quick-add task host the shell mounts: it waits for openQuickAddTask() and
// loads the sheet (QuickAddSheet) the first time it is asked for.

import { Suspense, useEffect, useState } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { OPEN_QUICK_ADD_TASK_EVENT, type QuickAddOptions, type QuickAddTarget } from "./openQuickAddTask";
import { onWindow } from "../../lib/globalEvents";

const QuickAddSheet = lazyWithReload(() => import("./QuickAddSheet"));

export default function QuickAddTask() {
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState<QuickAddTarget | null>(null);
  const [day, setDay] = useState<string | undefined>(undefined);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ into: QuickAddTarget | null } & QuickAddOptions | undefined>).detail;
      setInto(detail?.into ?? null);
      setDay(detail?.day);
      setOpen(true);
    };
    return onWindow(OPEN_QUICK_ADD_TASK_EVENT, handler);
  }, []);
  return open ? <Suspense fallback={null}><QuickAddSheet into={into} day={day} onClose={() => setOpen(false)} /></Suspense> : null;
}
