// The app's side of lib/taskRefs: the task rows the reader holds, as link
// targets. Called once from the workspace shell; the published site never
// registers, so a task link or embed there resolves to nothing.

import { useEffect, useMemo } from "react";
import { useTaskRows, useAllNodes } from "./appStore";
import { useCapabilities } from "./capabilities";
import { registerTaskRefs, taskRefsFrom, type TaskRef } from "./taskRefs";

let current: readonly TaskRef[] = [];
const listeners = new Set<() => void>();

const source = {
  tasks: () => current,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

export function useRegisterTaskRefs(online: boolean): void {
  const tasks = useTaskRows();
  const notes = useAllNodes();
  const capabilities = useCapabilities(online);
  const refs = useMemo(
    () => taskRefsFrom(tasks, notes, (space) => capabilities.canEdit({ node_type: "content", space_id: space })),
    [tasks, notes, capabilities],
  );
  useEffect(() => {
    current = refs;
    registerTaskRefs(source);
    for (const listener of [...listeners]) listener();
  }, [refs]);
  useEffect(() => () => { current = []; registerTaskRefs(null); }, []);
}
