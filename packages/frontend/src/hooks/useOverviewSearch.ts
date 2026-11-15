// Sidebar search (H4): the query lives in the app store (so the global Cmd+F /
// Escape shortcuts can drive it without prop-threading), the RESULTS live here
// — local state of whichever component renders the search list
// (OverviewSidebar). Typing in the search box therefore re-renders the
// sidebar only, not the BuilderApp tree.
//
// What is found is reads.notes.search, the same search the command palette
// runs. This hook adds what only the sidebar shows: the 120ms debounce, the
// ancestor path and the title highlight. A request that a newer keystroke
// overtook is aborted and its answer ignored.

import { useCallback, useEffect, useMemo, useState } from "react";
import { reads, type NoteSearchOutcome } from "../lib/data";
import type { ContentNode } from "../lib/api";
import { useAppSelector, selectSearchableNodes } from "../lib/appStore";
import { parseSearchQuery, type Snippet } from "@onden/markdown";
import { ancestorsOf, indexById } from "../lib/treeWalk";

export type SearchResult = {
  id: string;
  title: string;
  node_type: string;
  /** The loaded note, when this device has it (a delete button, the path); null for a note only the server named. */
  node: ContentNode | null;
  snippet: Snippet | null;
  path: string[];
  titleIndices: [number, number][];
};

/** What one finished request answered, with the query it answered. */
type Answer = { query: string; outcome: NoteSearchOutcome } | { query: string; outcome: null };

function exactTitleRanges(text: string, title: string): [number, number][] {
  const ranges: [number, number][] = [];
  const needle = text.toLowerCase();
  if (!needle) return ranges;
  const haystack = title.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) ranges.push([at, at + text.length]);
  return ranges;
}

export function useOverviewSearch() {
  const overviewSearch = useAppSelector((s) => s.overviewSearch);
  // Hidden notes are searchable too, as in the palette and on the server.
  const overviewNodes = useAppSelector(selectSearchableNodes);
  const [answer, setAnswer] = useState<Answer | null>(null);

  const query = overviewSearch.trim();
  useEffect(() => {
    if (!query) { setAnswer(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      reads.notes.search(query, { signal: controller.signal }).then(
        (outcome) => { if (!controller.signal.aborted) setAnswer({ query, outcome }); },
        () => { if (!controller.signal.aborted) setAnswer({ query, outcome: null }); },
      );
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  // Ancestor titles of a result, through an id lookup and only for the
  // results: building a path for every note with a scan per ancestor, on every
  // store change, was quadratic in the number of notes.
  const nodesById = useMemo(() => indexById(overviewNodes), [overviewNodes]);
  const ancestorTitles = useCallback(
    (node: ContentNode): string[] => ancestorsOf(nodesById, node).map((parent) => parent.title),
    [nodesById],
  );

  const overviewSearchResults = useMemo<SearchResult[]>(() => {
    if (!query || !answer?.outcome) return [];
    const text = parseSearchQuery(answer.query).text;
    return answer.outcome.rows.map((row) => {
      const node = nodesById.get(row.id) ?? null;
      return {
        id: row.id,
        title: row.title,
        node_type: row.node_type,
        node,
        snippet: row.snippet,
        path: node ? ancestorTitles(node) : [],
        titleIndices: row.titleRanges ?? exactTitleRanges(text, row.title),
      };
    });
  }, [query, answer, nodesById, ancestorTitles]);

  return {
    overviewSearch,
    overviewSearchResults,
    /** Where the rows came from (offline notice); null until the first answer. */
    overviewSearchOutcome: query ? answer?.outcome ?? null : null,
    /** The latest request failed for a reason a local copy cannot cover. */
    overviewSearchFailed: !!query && answer !== null && answer.outcome === null,
  };
}
