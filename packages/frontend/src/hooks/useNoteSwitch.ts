import { useRef, useState } from "react";
import type { ContentNode } from "../lib/api";
import { useTagRows } from "../lib/appStore";
import { noteSwitchOn, setNoteSwitch } from "../lib/noteSwitch";

/** A module's note switch (FrontendModule.noteSwitch) for one note: whether the
 *  note takes part, and a way to change it (lib/noteSwitch). `set` resolves true
 *  once the server accepted the change or it is durably queued. */
export function useNoteSwitch(node: ContentNode, moduleId: string) {
  const tags = useTagRows() ?? [];
  const on = noteSwitchOn(node, moduleId, tags);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);

  async function set(next: boolean): Promise<boolean> {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    try { return await setNoteSwitch(node, moduleId, next, tags); }
    finally { writing.current = false; setBusy(false); }
  }

  return { on, busy, set };
}
