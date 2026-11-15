// The one note search (reads.notes.search): the sidebar and the command palette
// (and the `((` / `[[` pickers) ask here, so one query gives the same notes in
// the same order from either door.
//
// Order of answers:
//   1. the server (pgroonga; #tag and key:value filters; only what the reader
//      may see; title equal to / starting with the text first);
//   2. when the network is down or the request fails for a retryable reason,
//      this device's own index (localCopy.search, same title-first order), with
//      #tag filtered from the store; key:value cannot be, which the outcome says;
//   3. when that source found nothing, a typo-tolerant match over the loaded
//      notes (Fuse.js);
//   4. online with semantic search on and plain text in the query: a few notes
//      whose meaning is near it, after everything above (never ahead of an
//      exact match; offline there is none).
// The query syntax is @onden/markdown parseSearchQuery, the parser the server
// itself uses.

import { isBrowserOnline } from "../browserNetwork";
import { loadFuse } from "../lazyFuse";
import { parseSearchQuery, type Snippet } from "@onden/markdown";
import { api, type ContentNode } from "../api";
import { shellFeatureOnIn } from "../shellFeatures";
import { moduleReads } from "./moduleReads";
import { getAppState, selectSearchableNodes } from "../appStore";
import { nodeTagIds, tagMembersResolver } from "../nodeTags";
import { byUpdatedDesc } from "../noteOrder";
import { classifyWriteFailure } from "./writeErrors";
import { localCopy } from "./sync";

export type NoteSearchRow = {
  id: string;
  title: string;
  node_type: string;
  snippet: Snippet | null;
  /** Half-open [start, end) ranges of `title` a typo-tolerant match hit; absent for other rows. */
  titleRanges?: [number, number][];
};

export type NoteSearchOutcome = {
  rows: NoteSearchRow[];
  /** The rows come from this device's copy, not the server. */
  offline: boolean;
  /** The query holds key:value filters this device could not apply (offline). */
  fieldFilterSkipped: boolean;
};

/** As many rows as the server returns by default (services/nodeSearch.ts). */
const RESULT_LIMIT = 30;

export async function searchNotes(query: string, { signal }: { signal?: AbortSignal } = {}): Promise<NoteSearchOutcome> {
  const parsed = parseSearchQuery(query);
  const online = isBrowserOnline();
  // The server answers no text shorter than two characters (routes/nodes.ts);
  // one Chinese character is a real search, so this device's index takes it.
  const tooShortForServer = query.trim().length < 2;
  if (tooShortForServer && parsed.text) {
    return { rows: await localRows(parsed), offline: false, fieldFilterSkipped: false };
  }
  if (online) {
    try {
      // Asked together: the meaning search waits on a model, the exact one must not wait behind it.
      const [rows, byMeaning] = await Promise.all([
        api<NoteSearchRow[]>(`/api/nodes/search?q=${encodeURIComponent(query)}`, { signal }),
        meaningRows(parsed, signal),
      ]);
      return { rows: withMeaning(rows.length > 0 ? rows : await fuzzyRows(parsed), byMeaning), offline: false, fieldFilterSkipped: false };
    } catch (error) {
      if (signal?.aborted || classifyWriteFailure(error) !== "retryable") throw error;
    }
  }
  const fieldFilterSkipped = parsed.attrs.length > 0;
  const local = await localRows(parsed);
  return { rows: local.length > 0 ? local : await fuzzyRows(parsed), offline: true, fieldFilterSkipped };
}

type Parsed = ReturnType<typeof parseSearchQuery>;

/** Only a workspace whose server says semantic search is on (an older server sends no list: off). */
function meaningSearchOn(): boolean {
  const modules = getAppState().data.workspace?.modules;
  return Array.isArray(modules) && shellFeatureOnIn(modules, "meaning-search");
}

/** Notes near the query's meaning. The filters (#tag, key:value) cannot be applied to them, so a query with
 *  one asks for none. A failure here costs only the extra rows, never the exact answer. */
async function meaningRows(parsed: Parsed, signal?: AbortSignal): Promise<NoteSearchRow[]> {
  if (!parsed.text || parsed.tags.length > 0 || parsed.attrs.length > 0 || !meaningSearchOn()) return [];
  try {
    const hits = await moduleReads.semantic.search(parsed.text, signal);
    const byId = new Map(selectSearchableNodes(getAppState()).map((node) => [node.id, node]));
    return hits.flatMap(({ id }) => {
      const node = byId.get(id);
      return node ? [{ id, title: node.title, node_type: node.node_type, snippet: null }] : [];
    });
  } catch {
    return [];
  }
}

function withMeaning(rows: NoteSearchRow[], byMeaning: NoteSearchRow[]): NoteSearchRow[] {
  const seen = new Set(rows.map((row) => row.id));
  const extra = byMeaning.filter((row) => !seen.has(row.id));
  return [...rows, ...extra.splice(0, Math.max(0, RESULT_LIMIT - rows.length))];
}

/** The loaded notes carrying every #tag of the query (the tag, its child tags and
 *  the tags extending it, as the server counts them). key:value is not read here. */
function withTags(parsed: Parsed): ContentNode[] {
  const state = getAppState();
  const nodes = selectSearchableNodes(state);
  if (parsed.tags.length === 0) return nodes;
  const membersOf = tagMembersResolver(state.data.tags ?? []);
  return nodes.filter((node) => {
    const own = nodeTagIds(node);
    return parsed.tags.every((name) => own.some((id) => membersOf(name).has(id)));
  });
}

async function localRows(parsed: Parsed): Promise<NoteSearchRow[]> {
  const candidates = withTags(parsed);
  const byId = new Map(candidates.map((node) => [node.id, node]));
  const toRow = (node: ContentNode, snippet: Snippet | null): NoteSearchRow => ({ id: node.id, title: node.title, node_type: node.node_type, snippet });
  if (!parsed.text) {
    // Filters only: newest first, as on the server. Key:value alone leaves nothing to match on.
    if (parsed.tags.length === 0) return [];
    return [...candidates].sort(byUpdatedDesc).slice(0, RESULT_LIMIT).map((node) => toRow(node, null));
  }
  // The mirror holds no task rows; a note hidden from the tree stays findable, as on the server.
  // A failing local index is a failed search (neither door has an answer), not "no results".
  const hits = await localCopy.search(parsed.text);
  return hits.flatMap(({ id, snippet }) => {
    const node = byId.get(id);
    return node ? [toRow(node, snippet)] : [];
  }).slice(0, RESULT_LIMIT);
}

/** Typo-tolerant match (Fuse.js) over the loaded notes, for what the exact
 *  sources did not find. Needs text to compare; filters narrow the notes. */
async function fuzzyRows(parsed: Parsed): Promise<NoteSearchRow[]> {
  if (!parsed.text || parsed.attrs.length > 0) return [];
  // The snippet code loads with Fuse: only this typo-tolerant path (after the exact sources found nothing) needs it here.
  const [Fuse, { snippetAround }] = await Promise.all([loadFuse(), import("@onden/markdown/snippet")]);
  const fuse = new Fuse(withTags(parsed), {
    keys: [{ name: "title", weight: 2 }, { name: "markdown", weight: 0.5 }],
    threshold: 0.4,
    includeScore: true,
    includeMatches: true,
    minMatchCharLength: 2,
    ignoreLocation: true,
  });
  return fuse.search(parsed.text, { limit: RESULT_LIMIT }).map((result) => {
    const node = result.item;
    const titleMatch = result.matches?.find((m) => m.key === "title");
    const markdownMatch = result.matches?.find((m) => m.key === "markdown");
    // The fuzzy hit's own text is the term: the same snippetAround (and
    // contract) as every other search, around what Fuse matched.
    let snippet: Snippet | null = null;
    if (markdownMatch && markdownMatch.indices.length > 0 && node.markdown) {
      const [start, end] = markdownMatch.indices[0];
      snippet = snippetAround(node.markdown, [node.markdown.slice(start, end + 1)]);
    }
    return { id: node.id, title: node.title, node_type: node.node_type, snippet, titleRanges: (titleMatch?.indices ?? []).map(([a, b]): [number, number] => [a, b + 1]) };
  });
}
