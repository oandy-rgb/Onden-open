// The cold-start payload (GET /api/bootstrap) and the rows it carries: edges, tasks, suggestions, events, pointers, attributes.
// Pure types: the app imports them with `import type`, so nothing here may run.

import type { TaskStatus } from "@onden/markdown";
import type { LinkBinding, NoteAnchor, CanvasMembership } from "./blocks.js";
import type { ContentNode, ServerNode } from "./node.js";
import type { SiteConfig } from "./site.js";
import type { Tag } from "./tags.js";

export type NodeEdge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  /** A kind from the edge manifest (backend services/edgeManifest.ts;
   *  plugins register their own, so it is open-ended — lib/edgeKinds). */
  edge_type: string;
  /** "active", or a machine suggestion's "suggested" / "rejected". */
  status: string;
  /** Who made it: "manual" (drawn), or what the server derives it from —
   *  "wikilink", "citation", "semantic" (a suggestion). NULL on local rows
   *  stored before D74 until the next bootstrap. Read it through
   *  lib/edgeRoles (edgeRole and the view predicates), not directly. */
  origin?: string | null;
};

export type NodeTask = {
  id: string;
  /** The note the task is a line of or was added under; null for a standalone
   *  task (no note — it lives in `space_id`). */
  node_id: string | null;
  title: string;
  // D8 Phase 3: waiting (blocked) keeps noise off the agenda; doing is the
  // in-flight marker. done/cancelled are terminal. "later" is the old "parked":
  // the server never sends it now (it is `someday`), and a write of it is
  // todo + someday.
  status: TaskStatus;
  /** The day to do it, YYYY-MM-DD. */
  when_date?: string | null;
  /** The older name of `when_date` (same day), kept for devices and queued
   *  writes from before the tasks module; a time of day is `remind_at` now. */
  due_date?: string | null;
  /** Do it in the evening of `when_date`. */
  evening?: boolean;
  /** No day: whenever (parked). */
  someday?: boolean;
  /** The last day it may be done, YYYY-MM-DD. */
  deadline?: string | null;
  recur?: string | null;    // `<n><d|w|m>` — break-or-make recurrence
  /** fixed: on the schedule (照時間表); after: <n> after it is done (完成後起算). */
  recur_mode?: "fixed" | "after";
  /** When to remind: an ISO instant, or YYYY-MM-DDTHH:MM in the workspace's zone. */
  remind_at?: string | null;
  /** HH:MM it starts, and when it ends: written at the start of its line. */
  time?: string | null;
  until?: string | null;
  /** When it was completed (ISO instant); null unless done. */
  done_at?: string | null;
  /** The `^id` of its line in `node_id`, when it is a line of that note. */
  block_ref?: string | null;
  space_id?: string | null;
  /** The task has text of its own (read and written as a note body). */
  has_body?: boolean;
  // Server rows carry it (TASK_ROW_SELECT); the offline agenda orders its
  // completed tail by it, like GET /api/tasks/agenda (lib/data/taskAgenda.ts).
  updated_at?: string | null;
};

export type AiSuggestion = {
  id: string;
  target_id: string;
  suggestion_type: "summary" | "tags" | "edge";
  payload: Record<string, unknown>;
  status: string;
  reasoning: string | null;
};

// Full domain_events row as bootstrap ships it (SELECT *). The live event
// log re-declares a structurally compatible LiveEvent in useLiveEventLog.
export type DomainEvent = {
  id: number | string;
  actor_type: string;
  actor_id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  /** ER restore metadata (inverse patches etc.) — '{}' when none. */
  tx_meta: Record<string, unknown>;
  /** Cascade cause. pg bigint serializes as a string over JSON. */
  triggered_by_event_id: string | number | null;
  /** True when the event's side effect ran outside PG (not auto-undoable). */
  external: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  home_node_id: string | null;
  /** The built-in modules that are on (docs/architecture/module-library.md).
   *  Absent or null: every module counts as on (an older server or local copy). */
  modules?: string[] | null;
  /** Modules that wait for the owner's one-time yes before they are on
   *  (semantic search, RSS, website). Absent: none (an older server). */
  modules_to_confirm?: string[] | null;
  /** The zone the owner chose for the workspace's days (IANA name). null or
   *  absent: never chosen — `Bootstrap.timezone` (ONDEN_TIMEZONE) or the
   *  browser's zone stands in. Settings › Time. */
  time_zone?: string | null;
  /** The hour (0–6) a day starts at; 4 means 02:00 still counts as the day
   *  before. Absent (an older server or copy) reads as 0. */
  day_start_hour?: number;
};

export type NodeAttribute = {
  key: string;
  value: string;
  value_type: "text" | "number" | "date" | "bool" | "node_ref";
  is_inheritable: boolean;
  // Provenance / input rail (sync-protocol §2). Canonical values are
  // ui | markdown | frontmatter | dispatcher, plus 'derived' (a value Onden
  // computes: field defaults, a collection row's status). 'explicit' is the
  // legacy name of ui on old rows: read it as ui, never write it (backend
  // spine/attributeSource.ts, D106).
  source: "ui" | "markdown" | "frontmatter" | "dispatcher" | "explicit" | "derived";
};

export type NotePointer = {
  id: string;
  parent_id: string | null;
  target_id: string;
  sort_order: number;
  display_prefix: string | null;
};

export type Bootstrap = {
  /** Whether node bodies were shipped ("full") or stripped for the slim
   *  ?bodies=none mode ("none" — body_len rides on each node).
   *  Optional only for locally constructed fallback data. */
  bodies?: "none" | "full";
  /** Event cursor the payload is current to (GAP-249). A device with no sync
   *  cursor yet starts its event sync here instead of replaying since=0.
   *  Missing on older servers and on locally constructed data. */
  last_event_id?: string;
  /** The membership epoch of the readable set this payload lists (same
   *  snapshot as its rows); absent from an older server. */
  membership_epoch?: number;
  /** When the server read this payload (ISO). Compare server-made timestamps
   *  (a board's created_at) with it, never with this device's clock. */
  server_time?: string;
  /** ?nodes=none: the per-node channels (nodes, edges, tasks, pointers,
   *  attributes, blocks) were left out, not emptied — only what the sync
   *  delta does not carry came (syncEngine refreshMeta). */
  nodes_omitted?: true;
  /** Lean bootstrap (asked for with `X-Onden-Bootstrap: lean`): nodes carry
   *  no attrs map — it is rebuilt from `attributes` on receipt
   *  (syncEngine.fetchBootstrap) — and these attribute keys' values were left
   *  out (drawings: read on open, lib/ink/store). */
  attrs_omitted?: true;
  deferred_attribute_keys?: string[];
  workspace: Workspace;
  nodes: ContentNode[];
  edges: NodeEdge[];
  tasks: NodeTask[];
  suggestions: AiSuggestion[];
  events: DomainEvent[];
  /** Roles are retired (spaces decide access): the server no longer sends it; only the local copy and the offline fallback set it. */
  actor_role?: string | null;
  /** The caller is the workspace owner (backend spine/authority.ts
   *  isWorkspaceOwner): the one who administers members, modules, tag
   *  definitions and the site. Another admin is not. Missing (an older
   *  server) reads as not the owner. */
  actor_is_owner?: boolean;
  /** The caller may approve or reject agent changes in the inbox (backend
   *  spine/authority.ts reviewAuthority). Missing reads as no. */
  can_review?: boolean;
  /** Fresh-server hint for automatic onboarding examples. Missing (old server
   *  or local cache) is ineligible; normal write authorization still applies. */
  example_seed_eligible?: boolean;
  tags?: Tag[];
  site_config?: SiteConfig;
  chrome?: Record<string, unknown> | null;
  pointers?: NotePointer[];
  /** Typed attributes of the returned nodes (type, inheritance, source).
   *  Older servers omit it; the client then falls back to nodes[].attrs. */
  attributes?: Array<{ node_id: string; key: string; value: string; value_type: string; is_inheritable: boolean; source: string }>;
  /** The server's calendar zone — the owner's choice or ONDEN_TIMEZONE: "today"
   *  for due dates and the agenda. Sent only when one is set; older servers
   *  omit it (the browser's zone stands in). `workspace.time_zone` is newer
   *  than this value after a change (the sync delta carries the workspace). */
  timezone?: string;
  canvas_memberships?: CanvasMembership[];
  graph_positions?: GraphPosition[];
  /** Where each held note's paragraphs are (backend services/blockAnchors); omitted by a ?nodes=none snapshot. */
  note_anchors?: NoteAnchor[];
  /** What the server has switched on; `paragraph_anchors` false/absent hides 「本篇的段落」 and 「獨立出去」. */
  features?: { block_nodes?: boolean; paragraph_anchors?: boolean };
  /** Which anchor each part link written in a held note means (backend services/blockLinks). */
  note_link_bindings?: LinkBinding[];
};

export type GraphPosition = { nodeId: string; x: number; y: number };

/** One attribute of a note as a sync delta or the bootstrap sends it. Attributes are keyed by (node_id, key): there is no
 *  surrogate id in the schema, so deltas use the pair as the identifier. */
export type AttributeDelta = {
  node_id: string;
  key: string;
  value: string;
  value_type: string;
  is_inheritable: boolean;
  source: string;
};

/** The /api/sync response body. `resync_required`: the held set was too large to diff, so the client must drop its mirror
 *  and re-bootstrap (read-policy-filtered and complete) instead of trusting an incomplete delta. */
export type SyncDelta = {
  resync_required?: true;
  last_event_id: number;
  /** Where the workspace's event log ends (a decimal string). A client whose cursor is beyond it was restored from a
   *  newer database than the server's and must start over from a bootstrap. */
  head_event_id: string;
  /** The workspace membership epoch at the time of this delta; the client reconciles read-membership only when it
   *  advances past its last-reconciled value. */
  membership_epoch?: number;
  /** Complete currently visible tag catalog; omitted keeps the cached catalog, [] clears it. Typed as the app reads it
   *  (the app's SyncDelta narrows it to Tag[]): the server builds these rows by a cast (backend services/tagCatalog.ts),
   *  so a mismatch with Tag is not yet a type error there. */
  tags?: Array<{ id: string } & Record<string, unknown>>;
  nodes: { upsert: ServerNode[]; delete: string[] };
  /** `replace_for`: node ids whose touching edges in `upsert` are the complete readable set. */
  edges: { upsert: NodeEdge[]; delete: string[]; replace_for?: string[] };
  pointers?: { upsert: NotePointer[]; delete: string[]; replace_for: string[] };
  /** "Appears on canvases": every membership touching a `replace_for` id (as note or as canvas), complete for those ids. */
  canvas_memberships?: { upsert: CanvasMembership[]; replace_for: string[] };
  /** Paragraph anchors of every shipped note, complete for those notes (`replace_for`). */
  note_anchors?: { upsert: NoteAnchor[]; replace_for: string[] };
  /** Which anchor each `[[筆記/段落]]` link written in a shipped note means, complete for those notes (`replace_for`). */
  note_link_bindings?: { upsert: LinkBinding[]; replace_for: string[] };
  tasks: { upsert: NodeTask[]; delete: string[] };
  attributes: { upsert: AttributeDelta[]; delete: Array<{ node_id: string; key: string }> };
  workspace: Workspace | null;
  /** The site config and chrome, the reader's view as the bootstrap ships them; present only after they changed. */
  site_config?: unknown;
  chrome?: unknown;
};
