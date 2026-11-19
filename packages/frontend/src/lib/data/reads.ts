// Server reads (depth audit D11). Every read a core component or hook makes
// lives here: the endpoint, its query string, the response parsing and any
// offline fallback. Callers import `reads` from lib/data and never build an
// /api/... URL themselves (eslint onden/reads-through-data). Modules' endpoints
// are in moduleReads.ts (reads.modules).
//
// A response shape that only one view renders stays declared in that view;
// those reads take it as a type parameter. Shapes shared across the app come
// from lib/api or lib/data.

import {
  api, apiFetch, nodeNeedsBody, postRead, postReadResponse,
  type Bootstrap, type ContentNode, type InboxEvent, type InboxFacets, type InboxGroup,
  type NodeAttribute, type PendingApproval,
} from "../api";
import { hasPendingWrite } from "./writeQueue";
import { dedupedGet } from "./queryCache";
import { writeTargets, type TargetedWrite } from "../pendingWriteTargets";
import { localCopy } from "./sync";
import type { InkKind } from "@onden/markdown/ink";
import type { PartLinkExportMode } from "@onden/markdown";
import type { Agenda } from "./taskAgenda";
import { viewOwnerPath, type ViewOwner } from "./viewOwner";
import { moduleReads } from "./moduleReads";
import { searchNotes } from "./noteSearch";
import type { AiCredentialTestRequest, AiCredentialTestResult, BlockCitationRow, BlockHome, DayInkChange, FocusSession, InkEdit, NoteParagraph, Page } from "@onden/contract";

export type { NoteSearchOutcome, NoteSearchRow } from "./noteSearch";
/** `actor_kind`: who wrote it as the server words it ('session': a temporary session, sent with no name; services/authorName.ts). */
export type NoteVersion = { id: string; title: string; markdown: string; changed_at: string; actor_name: string | null; actor_type: string | null; actor_kind?: "human" | "agent" | "system" | "session" };
export type InkVersion = { id: string; ink_data: string };
export type { InkKind } from "@onden/markdown/ink";
const enc = encodeURIComponent;

/** The workspace history screen (lib/history/workspaceHistoryApi.ts owns the shapes). */
const history = {
  // `space` = a space id: only that space's notes (absent = every space the caller can read).
  activity: <T>(days: number, until?: string, space?: string) => api<T>(`/api/history/activity?days=${days}${until ? `&until=${enc(until)}` : ""}${space ? `&space=${enc(space)}` : ""}`),
  feed: <T>(until: string, days: number, space?: string) => api<T>(`/api/history/feed?until=${enc(until)}&days=${days}${space ? `&space=${enc(space)}` : ""}`),
  dayNotes: <T>(date: string, offset: number, limit: number, space?: string) => api<T>(`/api/history/day/notes?date=${enc(date)}&offset=${offset}&limit=${limit}${space ? `&space=${enc(space)}` : ""}`),
  deleted: <T>(days: number, space?: string, before?: string) =>
    api<T>(`/api/history/deleted?${before ? `before=${enc(before)}` : `days=${days}`}${space ? `&space=${enc(space)}` : ""}`),
  deletedBody: <T>(id: string) => api<T>(`/api/history/deleted/${enc(id)}`),
  /** The notes as they were at the instant `t` (ISO), against now; `space` as above. */
  at: <T>(t: string, space?: string) => api<T>(`/api/history/at?t=${enc(t)}${space ? `&space=${enc(space)}` : ""}`),
  /** One note then and now. */
  atNote: <T>(id: string, t: string, space?: string) => api<T>(`/api/history/at/${enc(id)}?t=${enc(t)}${space ? `&space=${enc(space)}` : ""}`),
};

/** Notes: full rows, history, search and attributes. */
const notes = {
  /** 「本篇的段落」: the note's paragraphs that are block nodes, with where each one is (here, standing alone as a
   *  note, lost). Null when the server cannot answer (offline): the panel then reads the note's own text. */
  async paragraphs(id: string): Promise<NoteParagraph[] | null> {
    try { return (await api<{ paragraphs: NoteParagraph[] }>(`/api/nodes/${enc(id)}/paragraphs`)).paragraphs; } catch { return null; }
  },
  /** One note with its body (a slim row has none). */
  full: (id: string) => api<ContentNode>(`/api/nodes/${enc(id)}`),
  /** The text of a note for reading only (the link-target list): the open
   *  row's body, else this device's stored copy (so it works offline), else
   *  the server's. Null when none of them can answer. Not a snapshot to
   *  write from: a write re-reads the note. */
  async body(node: Pick<ContentNode, "id" | "markdown" | "body_len">): Promise<string | null> {
    if (!nodeNeedsBody(node)) return node.markdown ?? "";
    const stored = await localCopy.body(node.id).catch(() => null);
    if (stored !== null) return stored;
    try { return (await api<ContentNode>(`/api/nodes/${enc(node.id)}`)).markdown ?? ""; } catch { return null; }
  },
  /** The other note the caller reads that holds block `^ref` when note `id`
   *  no longer does (`[[Note#^ref]]` fallback; the server picks, @onden/markdown
   *  chooseBlockHome). Null: none, several, or the server cannot answer
   *  (offline) — the link then opens the note it names, as before. */
  async blockHome(id: string, ref: string): Promise<BlockHome | null> {
    try { return (await api<{ home: BlockHome | null }>(`/api/nodes/${enc(id)}/block-home/${enc(ref)}`)).home; } catch { return null; }
  },
  /** Who cites the paragraphs of note `id` (`[[Note#^ref]]`, `![[Note#^ref]]`): only
   *  notes the caller can read are listed or counted (the server cuts them in the query).
   *  Empty when none cite it, or the server cannot answer (offline) — the number beside a
   *  paragraph is then simply not shown. */
  async blockCitations(id: string): Promise<BlockCitationRow[]> {
    try { return (await api<{ citations: BlockCitationRow[] }>(`/api/nodes/${enc(id)}/block-citations`)).citations; } catch { return []; }
  },
  /** A stored media file's bytes (Word export embeds pictures); null when the server does not have it or cannot answer. */
  async mediaBytes(id: string): Promise<Uint8Array | null> {
    try {
      const response = await apiFetch(`/api/media/${enc(id)}`);
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    } catch { return null; }
  },
  versions: (id: string) => api<NoteVersion[]>(`/api/nodes/${id}/versions`),
  /** One row per save, newest first, at most 50 (the grouped feed above merges saves into sessions). */
  rawVersions: (id: string) => api<NoteVersion[]>(`/api/nodes/${enc(id)}/versions?raw=1`),
  /** Recent versions across the workspace, newest first. */
  recentVersions: <T>() => api<Page<T>>("/api/versions/recent?limit=100"),
  inkVersions: (id: string, kind: InkKind = "handwriting") => api<InkVersion[]>(`/api/nodes/${id}/ink-versions?kind=${kind}`),
  /** One drawing's edits of a note, newest first, as counts (History; the drawings come with `inkChange`). */
  inkEdits: (id: string, kind: InkKind) => api<InkEdit[]>(`/api/nodes/${enc(id)}/ink-edits?kind=${kind}`),
  /** The two drawings behind one change, read when it is opened. */
  inkChange: (id: string, kind: InkKind, change: Pick<DayInkChange, "before_event" | "after_event">) =>
    api<{ before: string | null; after: string }>(`/api/nodes/${enc(id)}/ink-change?kind=${kind}&${change.before_event ? `before=${enc(change.before_event)}&` : ""}after=${enc(change.after_event)}`),
  /** What deleting a deleted note for good would take (lib/data/notePurge.ts). */
  purgePreview: <T>(id: string) => api<T>(`/api/nodes/${enc(id)}/purge-preview`),
  /** The one note search (lib/data/noteSearch.ts): the server first, this
   *  device's index when offline, a typo-tolerant match when neither finds
   *  anything. The outcome says when the rows are offline ones. */
  search: searchNotes,
  /** Own, inherited and rolled-up attributes for the attributes panel. A
   *  failed own read rejects; the other two read as empty. */
  async attributePanel<I, R>(id: string): Promise<{ own: NodeAttribute[]; inherited: I[]; rollups: R[] }> {
    // Separate endpoints: inheritance walks a recursive CTE on the server, and
    // most consumers only need local values.
    const [ownRes, inhRes, rollupRes] = await Promise.all([
      apiFetch(`/api/nodes/${id}/attributes`),
      apiFetch(`/api/nodes/${id}/inherited-attributes`),
      apiFetch(`/api/nodes/${id}/rollup-attributes`),
    ]);
    if (!ownRes.ok) throw new Error(await ownRes.text());
    return {
      own: await ownRes.json() as NodeAttribute[],
      inherited: inhRes.ok ? await inhRes.json() as I[] : [],
      rollups: rollupRes.ok ? await rollupRes.json() as R[] : [],
    };
  },
  /** One attribute row of one note as this device last saw it (type and "shares to children" flag included). */
  attributeRecord: (id: string, key: string) => localCopy.attributeRecord(id, key),
  /** Some attribute values of one note. While a write to its attributes is
   *  queued, or the server cannot answer, the on-device copy answers. */
  async attributeValues<K extends string>(id: string, keys: readonly K[]): Promise<Record<K, string | null>> {
    const fromMirror = async () => Object.fromEntries(await Promise.all(
      keys.map(async (key) => [key, await localCopy.attribute(id, key).catch(() => null)] as const),
    )) as Record<K, string | null>;
    const queuedAttribute = (write: TargetedWrite) => writeTargets(write)
      .some((target) => target.kind === "node" && target.id === id && target.part?.split("/")[0] === "attributes");
    if (await hasPendingWrite(queuedAttribute).catch(() => false)) return fromMirror();
    try {
      const res = await apiFetch(`/api/nodes/${id}/attributes?keys=${keys.map(enc).join(",")}`);
      if (!res.ok) return fromMirror();
      const attrs = await res.json() as Array<{ key: string; value: string; value_type?: string; is_inheritable?: boolean; source?: string }>;
      // Drawings are not in the bootstrap: keep a copy of what was read, so
      // this note opens offline too. Never replaces a value already here.
      if (attrs.length) void localCopy.fillAttributes(id, attrs).catch(() => null);
      return Object.fromEntries(keys.map((key) => [key, attrs.find((a) => a.key === key)?.value ?? null])) as Record<K, string | null>;
    } catch {
      return fromMirror();
    }
  },
  /** Server-rendered HTML of a note snapshot (a POST that writes nothing). */
  exportHtml: (id: string, body: { title: string; markdown: string }) =>
    postRead<{ html: string }>(`/api/nodes/${enc(id)}/export-preview`, body),
  /** A note snapshot as the Markdown zip's file for it (frontmatter included). */
  exportMarkdown: (id: string, body: { title: string; markdown: string; part_links?: PartLinkExportMode }) =>
    postRead<{ markdown: string }>(`/api/nodes/${enc(id)}/export-preview`, { ...body, format: "markdown" }),
};

/** The workspace as a whole. */
const workspace = {
  /** Every readable note id, without bodies (the full bootstrap is capped). */
  slimBootstrap: () => api<Bootstrap>("/api/bootstrap?bodies=none"),
  /** One day for the 日子 page's timeline: `items` (edit runs, notes created, agent work) plus the older per-kind buckets. */
  dayLens: <T>(date: string) => api<T>(`/api/day/${date}/lens`),
  taskAgenda: () => api<Agenda>("/api/tasks/agenda"),
  /** A day's focus records (that began on it) and the one still running, whatever day it began (omit `day`: today). */
  focusOfDay: (day?: string) => api<{ day: string; sessions: FocusSession[]; running: FocusSession | null }>(`/api/tasks/focus${day ? `?day=${enc(day)}` : ""}`),
  /** Subscribed calendars (modules/external_calendars): "" is the person's list (and whether the server can keep
   *  addresses), "/events?from=YYYY-MM-DD&to=YYYY-MM-DD" the events touching those workspace days. */
  externalCalendars: <T>(path = "") => api<T>(`/api/external-calendars${path}`),
  /** Edge kinds this instance knows (plugins add their own); [] when unreadable. */
  edgeManifest: <T>() => apiFetch("/api/edges/manifest")
    .then((r) => r.ok ? r.json() as Promise<T[]> : [])
    .then((m) => Array.isArray(m) ? m : []),
  /** A structured query block's rows; the raw response, so the caller can
   *  show the server's error text. */
  query: (spec: unknown) => postReadResponse("/api/query", spec),
  /** A web page's title, fetched by the server (routes/bookmark.ts — the
   *  same fetch a bookmark uses; it creates nothing). Null when the page has
   *  none or cannot be reached. */
  linkTitle: (url: string, signal?: AbortSignal) =>
    postRead<{ title: string | null }>("/api/bookmark/preview", { url }, { signal }).then((r) => r.title ?? null),
};

/** Events: the log, the inbox and restore previews. */
const events = {
  page: <T>(params: URLSearchParams, signal?: AbortSignal) => api<{ events: T[] }>(`/api/events?${params}`, { signal }),
  /** What restoring (or rejecting) one event would do. */
  preview: <T>(eventId: string | number) => api<T>(`/api/events/${eventId}/preview`),
  inbox: (query: string, signal?: AbortSignal) => api<{ events: InboxEvent[]; groups?: InboxGroup[]; facets?: InboxFacets }>(
    `/api/inbox${query ? `?${query}` : ""}`, { signal }),
  approvals: (signal?: AbortSignal) => api<{ approvals: PendingApproval[] }>("/api/inbox/approvals", { signal }),
  /** Owner only (others get empty lists): the newest failed deliveries and
   *  every one of them counted by kind. */
  failedEffects: <T, G = never>() => api<{ failed: T[]; groups?: G[]; total?: number }>("/api/inbox/failed-effects"),
};

/** Saved views of a tag or a note, and one page of a view's rows (a Page
 *  plus the view config); `offset` is the previous page's `next`. */
const views = {
  list: <T>(owner: ViewOwner) => api<{ views: T[] }>(`${viewOwnerPath(owner)}/views`),
  run: <T>(owner: ViewOwner, viewId: string, page: { offset?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (page.offset) qs.set("offset", String(page.offset));
    if (page.limit) qs.set("limit", String(page.limit));
    const query = qs.toString();
    return api<T>(`${viewOwnerPath(owner)}/views/${enc(viewId)}/exec${query ? `?${query}` : ""}`);
  },
};

/** Tags. Their saved views are `views` above. */
const tags = {
  all: <T>() => api<T[]>("/api/tags"),
  deletePreview: <T>(id: string) => api<T>(`/api/tags/${id}/delete-preview`),
  exportPack: (id: string) => api<Record<string, unknown>>(`/api/tags/${id}/export`),
  /** The paragraphs carrying the tag (or a member tag) themselves, a page at a time (block nodes are not in the local store). */
  blocks: <T>(id: string, offset = 0) => api<T>(`/api/tags/${id}/blocks${offset ? `?offset=${offset}` : ""}`),
};

/** People, agents and spaces. */
const people = {
  actors: <T>() => api<T[]>("/api/actors"),
  /** One of the signed-in person's own preferences, kept on the server so it
   *  follows them to every device (GET /api/me/prefs/:key; null when unset). */
  myPref: <T>(key: string) => api<{ value: T | null }>(`/api/me/prefs/${enc(key)}`),
  actorStats: <T>(actorId: string) => api<T>(`/api/actors/${actorId}/stats`),
  actorTokens: <T>(actorId: string) => api<T[]>(`/api/actors/${actorId}/tokens`),
  spaces: <T>() => api<{ spaces: T[] }>("/api/spaces"),
  spaceOverview: <T>() => api<T>("/api/spaces/overview"),
  spaceMembers: <T>(spaceId: string) => api<{ members: T[] }>(`/api/spaces/${spaceId}/members`),
  /** What deleting a shared space meets: live notes and deleted ones. */
  spaceDeletePreview: <T>(spaceId: string) => api<T>(`/api/spaces/${enc(spaceId)}/delete-preview`),
  spaceCandidates: (spaceId: string) =>
    api<{ people: Array<{ id: string; name: string; type?: string }> }>(`/api/spaces/${spaceId}/candidates`),
  moveToSpacePreview: <T>(nodeId: string, toSpaceId: string) =>
    api<T>(`/api/spaces/move-preview?node=${enc(nodeId)}&to=${enc(toSpaceId)}`),
  /** How many of the owner's RSS subscriptions keeping them in this space would move, and how many stay because the space already follows the feed (owner only). */
  rssSourceSpacePreview: (toSpaceId: string) => api<{ movable: number; skipped_duplicate: number }>(`/api/rss/source-space/preview?space_id=${enc(toSpaceId)}`),
};

/** AI requests from a note's @mentions (docs/archive/architecture/agent-mentions-2026-10-22.md). */
const agentMentions = {
  /** The AIs this person could mention in the note, and the one `@ai` means. */
  mentionables: <T>(nodeId: string) => api<T>(`/api/nodes/${enc(nodeId)}/mentionables`),
  /** The newest request of each mention in the note. */
  /** The skill catalogue (built-in skills and the person's own skill notes). */
  skills: <T>() => dedupedGet<{ skills: T[] }>("/api/skills", { ttlMs: 5_000 }),
  /** The AIs that answer to an @handle (owner only). */
  runners: <T>() => api<{ runners: T[] }>("/api/agent-sessions/runners"),
  sessions: <T>(nodeId: string) => api<{ sessions: T[] }>(`/api/agent-sessions?node_id=${enc(nodeId)}`),
  /** One request (a mention's, or a selection action's). */
  session: <T>(sessionId: string) => api<{ session: T }>(`/api/agent-sessions/${enc(sessionId)}`),
};

/** What an AI proposed for a note and nobody has decided yet (docs/agents/decisions-ai-collaboration.md). */
const aiSuggestions = {
  forNote: <T>(nodeId: string) => api<T>(`/api/ai-suggestions?node_id=${enc(nodeId)}`),
};

/** The AI's API way of running (owner only): the server's ability to keep keys, the keys, a key's models, each role's runtimes. */
const aiRuntime = {
  status: () => api<{ api_runtime_offered: boolean }>("/api/ai/status"),
  credentials: <T>() => api<{ credentials: T[] }>("/api/ai/credentials"),
  models: <T>(credentialId: string) => api<{ models: T[] }>(`/api/ai/credentials/${enc(credentialId)}/models`),
  roles: <T>() => api<{ roles: T[] }>("/api/ai/roles"),
  /** Ask a service with a key and save nothing (a POST that writes nothing): its format and models, or why not. */
  testCredential: (body: AiCredentialTestRequest) => postRead<AiCredentialTestResult>("/api/ai/credentials/test", body),
  /** The same for a key that is kept. */
  testStoredCredential: (credentialId: string) => postRead<AiCredentialTestResult>(`/api/ai/credentials/${enc(credentialId)}/test`, {}),
  /** Who can take a selection or paragraph of this note, and the ways each can run now. */
  handToAi: <T>(nodeId: string) => api<T>(`/api/ai/hand-to-ai?node_id=${enc(nodeId)}`),
};

/** Lock-screen reminders: the key a browser subscribes with. 404 = this server has no VAPID keys (the feature is absent). */
const push = {
  key: () => api<{ public_key: string }>("/api/push/key"),
};

/** The info panel's 「AI」 tab: who can answer about a note, and this person's conversation with them. */
const panelChat = {
  roles: <T>(nodeId: string) => api<T>(`/api/ai/panel-chat/${enc(nodeId)}/roles`),
  thread: <T>(nodeId: string) => api<T>(`/api/ai/panel-chat/${enc(nodeId)}`),
};

export const reads = { notes, workspace, events, tags, views, people, history, agentMentions, aiSuggestions, aiRuntime, push, panelChat, modules: moduleReads };
