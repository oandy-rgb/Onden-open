import { useEffect, useState } from "react";
import { reads } from "../lib/data";
import type { BlockCitationRow } from "@onden/contract";

/** Wait this long after a note opens before asking, so opening never competes with it. */
const ASK_AFTER_MS = 600;

/** Who cites the paragraphs of note `nodeId` (reads.notes.blockCitations): empty
 *  until the answer arrives, while offline, and for a note nobody cites. */
export function useBlockCitations(nodeId: string | undefined, online: boolean): readonly BlockCitationRow[] {
  const [rows, setRows] = useState<readonly BlockCitationRow[]>([]);
  useEffect(() => {
    setRows([]);
    if (!nodeId || !online) return;
    let live = true;
    const timer = setTimeout(() => { void reads.notes.blockCitations(nodeId).then((found) => { if (live) setRows(found); }); }, ASK_AFTER_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [nodeId, online]);
  return rows;
}
