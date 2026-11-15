// The task a focus is on, as the screens show it: its name, and the note it lives
// in (the note beside the timer on a desktop). Both come from the local copy.

import { useAppSelector, useAllNodes } from "../../../lib/appStore";

export type FocusTask = { title: string; noteId: string | null; noteText: string | null };

export function useFocusTask(taskId: string | null | undefined): FocusTask | null {
  const task = useAppSelector((s) => (taskId ? s.data.tasks.find((row) => row.id === taskId) ?? null : null));
  const nodes = useAllNodes();
  if (!taskId) return null;
  const own = nodes.find((node) => node.id === taskId);
  const noteId = task?.node_id ?? own?.id ?? null;
  const note = noteId ? nodes.find((node) => node.id === noteId) : undefined;
  return { title: task?.title ?? own?.title ?? "", noteId, noteText: note?.markdown ?? null };
}
