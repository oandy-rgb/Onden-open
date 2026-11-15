// The rows of the `((` popup, and 「最近存的段落」 for the plain `[[` popup
// (lib/blockRefSearch holds the rules; this is the reading and timing):
//   • 「最近存的段落」 (lib/recentBlocksStore) are read once when a popup that
//     lists them opens, and listed first, narrowed by what was typed;
//   • what was typed is searched through the note index (reads.notes.search),
//     after a short pause so a burst of keystrokes asks once, and the notes it
//     names are cut into paragraphs (cached by text).
// With nothing typed `((` lists only 「最近存的段落」.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LinkTarget } from "@onden/markdown";
import type { ContentNode } from "../lib/api";
import { useOnline } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { reads } from "../lib/data";
import {
  BLOCK_REF_ROWS, createTargetCache, findBlockRefs, recentRows, withoutListed,
  type BlockRefRow, type NoteForRefs,
} from "../lib/blockRefSearch";
import { recentBlocksBound, recentBlocksStore, type RecentBlock } from "../lib/recentBlocksStore";
import { useSyncedPref } from "../lib/syncedPrefStore";
import { isNote } from "@onden/markdown/contract";

/** How long typing must pause before the index is asked. */
export const BLOCK_REF_PAUSE_MS = 120;

type Options = {
  nodes: readonly ContentNode[];
  /** The note being edited, and its text as the editor holds it now. */
  currentId: string | undefined;
  currentText: () => string;
};

export type BlockRefList = {
  /** The `((` rows: recent paragraphs that fit, then what the search found. */
  rows: BlockRefRow[];
  /** The plain `[[` list's 「最近存的段落」. */
  recentForWikilink: BlockRefRow[];
  searching: boolean;
};

export function useBlockRefs(popup: { type: string; query: string } | null, { nodes, currentId, currentText }: Options): BlockRefList {
  const online = useOnline();
  const caps = useCapabilities(online);
  const recentList = useSyncedPref(recentBlocksStore, recentBlocksBound).value;
  const cache = useRef(createTargetCache());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const wanted = popup?.type === "blockref" || popup?.type === "wikilink";
  const query = popup?.query ?? "";

  const noteOf = (id: string): NoteForRefs | null => {
    const node = nodesRef.current.find((n) => n.id === id);
    return node && isNote(node) ? { id, title: node.title, sameNote: id === currentId, writable: id === currentId || caps.canEdit(node) } : null;
  };
  const noteRef = useRef(noteOf);
  noteRef.current = noteOf;

  // Recent paragraphs: each note's text, read when the popup opens.
  const [loaded, setLoaded] = useState<{ list: readonly RecentBlock[] | null; texts: Map<string, LinkTarget[]> } | null>(null);
  useEffect(() => {
    if (!wanted || !recentList?.length) return;
    let live = true;
    void (async () => {
      const texts = new Map<string, LinkTarget[]>();
      await Promise.all([...new Set(recentList.map((entry) => entry.note))].map(async (id) => {
        const node = nodesRef.current.find((n) => n.id === id);
        if (!node) return;
        const body = id === currentId ? currentText() : await reads.notes.body(node);
        if (body !== null) texts.set(id, cache.current(id, body));
      }));
      if (live) setLoaded({ list: recentList, texts });
    })();
    return () => { live = false; };
    // The text of the open note is read as the popup opens, not on each edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, recentList, currentId]);

  const recent = useMemo(() => {
    if (!wanted || !recentList || loaded?.list !== recentList) return [];
    return recentRows(recentList, (id) => {
      const note = noteRef.current(id), targets = loaded.texts.get(id);
      return note && targets ? { note, targets } : null;
    }, query);
    // `caps` and `nodes` change the notes' standing; the texts do not move with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, recentList, loaded, query, currentId, caps, nodes]);

  // What was typed after `((`.
  const [found, setFound] = useState<{ query: string; rows: BlockRefRow[] } | null>(null);
  const typed = popup?.type === "blockref" ? query.trim() : "";
  useEffect(() => {
    if (!typed) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void findBlockRefs(typed, {
        search: async (q, signal) => (await reads.notes.search(q, { signal })).rows,
        note: (id) => noteRef.current(id),
        body: async (id) => {
          const node = nodesRef.current.find((n) => n.id === id);
          return node ? reads.notes.body(node) : null;
        },
        targets: cache.current,
        current: currentId ? { id: currentId, text: currentText } : null,
      }, abort.signal).then(
        (rows) => { if (!abort.signal.aborted) setFound({ query: typed, rows }); },
        () => { if (!abort.signal.aborted) setFound({ query: typed, rows: [] }); },
      );
    }, BLOCK_REF_PAUSE_MS);
    return () => { clearTimeout(timer); abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, currentId]);

  return useMemo(() => {
    const done = !!typed && found?.query === typed;
    const rows = popup?.type === "blockref"
      ? [...recent, ...withoutListed(done ? found!.rows : [], recent)].slice(0, BLOCK_REF_ROWS)
      : [];
    return { rows, recentForWikilink: popup?.type === "wikilink" ? recent : [], searching: !!typed && !done };
  }, [popup?.type, recent, found, typed]);
}
