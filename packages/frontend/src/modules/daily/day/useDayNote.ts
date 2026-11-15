// The note of one day, and what hangs under it (its captures), from the local copy; a slim bootstrap
// leaves bodies to the server, so the ones on show are fetched. The Journal page (DayPage) and the
// 今天 page's journal column read a day through this.

import { useEffect, useMemo } from "react";
import { nodeNeedsBody } from "../../../lib/api";
import { useAllNodes } from "../../../lib/appStore";
import { dataSync } from "../../../lib/data";
import { personalSpaceId } from "../../../lib/spaces";
import { dayChildren, dayNotesByDate } from "../journal";

export function useDayNote(date: string) {
  const nodes = useAllNodes();
  const spaceId = personalSpaceId();
  const byDate = useMemo(() => dayNotesByDate(nodes, spaceId), [nodes, spaceId]);
  const day = byDate.get(date);
  const captures = useMemo(() => (day ? dayChildren(nodes, day.id) : []), [nodes, day]);
  useEffect(() => {
    for (const n of day ? [day, ...captures] : []) if (nodeNeedsBody(n)) void dataSync.hydrateNode(n.id);
  }, [day, captures]);
  return { nodes, day, captures, byDate };
}
