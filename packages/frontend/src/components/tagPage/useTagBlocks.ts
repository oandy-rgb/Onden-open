import { useCallback, useEffect, useState } from "react";
import type { Page } from "@onden/contract";
import { reads } from "../../lib/data";
import { useLiveRefetch } from "../../lib/liveInvalidation";

/** A paragraph carrying the tag: its words and the note it is in (backend services/blockNodes.ts tagBlocks). */
export type TagBlock = { id: string; note_id: string; note_title: string; label: string };

const EMPTY: Page<TagBlock> = { rows: [], total: 0, next: null };

/** A page as the server sent it, or an empty one when the answer is not a page (an older server, an error body). */
function pageOf(answer: unknown): Page<TagBlock> {
  const a = answer as Partial<Page<TagBlock>> | null;
  if (!a || !Array.isArray(a.rows)) return EMPTY;
  return { rows: a.rows, total: typeof a.total === "number" ? a.total : a.rows.length, next: typeof a.next === "number" ? a.next : null };
}

/** The tag's paragraphs, read from the server a page at a time (the local store holds notes, not paragraphs).
 *  Offline or on a failed read the page lists none, as it lists nothing it cannot read. */
export function useTagBlocks(tagId: string): { rows: TagBlock[]; total: number; more: (() => void) | null } {
  const [page, setPage] = useState<Page<TagBlock>>(EMPTY);
  const load = useCallback(async () => {
    try {
      setPage(pageOf(await reads.tags.blocks<unknown>(tagId)));
    } catch {
      setPage(EMPTY);
    }
  }, [tagId]);
  useEffect(() => { void load(); }, [load]);
  useLiveRefetch("changed", load, { collapseEcho: true, onVisible: true });
  const next = page.next;
  const more = useCallback(async () => {
    if (next === null) return;
    try {
      const after = pageOf(await reads.tags.blocks<unknown>(tagId, next));
      setPage((before) => ({ rows: [...before.rows, ...after.rows], total: after.total ?? before.total, next: after.next }));
    } catch { /* the button stays; a later press tries again */ }
  }, [tagId, next]);
  return { rows: page.rows, total: page.total ?? page.rows.length, more: next === null ? null : () => { void more(); } };
}
