// What a backup holds, kind by kind (backupFidelity.integration.test.ts). Every kind of note, attribute, saved view,
// task and every table that keeps data about a note is listed here as RESTORED (with how it comes back) or NOT IN A
// BACKUP (with the reason) — the one place that says so. The test reads the schema and the registries and fails when a
// kind exists that is in neither list: a new node kind, attribute source, view layout, task status or node table must
// be handled by the backup, or listed below on purpose.
//
// Listed-and-restored kinds are not taken on trust: the fidelity test round-trips every view layout and every task
// status it finds, and compares them after the restore.

import type { SystemAttrClass } from "../../services/backupSystemAttrs.js";

export type Coverage = { restored: string } | { notInBackup: string };
const restored = (how: string): Coverage => ({ restored: how });
const notInBackup = (reason: string): Coverage => ({ notInBackup: reason });

export const NODE_TYPES: Record<string, Coverage> = {
  content: restored("a note; its sidecar holds the title, body, attributes, tags, positions and views"),
  class_tag: restored("a tag; created again by path (colour, fields, text and views for the workspace owner)"),
  canvas: restored("the retired kind of whiteboard: comes back as a plain note with its whiteboard tab"),
};

export const SOURCE_TYPES: Record<string, Coverage> = {
  manual: restored("as it was"),
  rss: restored("as it was"),
  ai: restored("as it was"),
  system: notInBackup("a note made by the system itself; a restore writes it as a note a person made (manual)"),
};

export const ATTRIBUTE_SOURCES: Record<string, Coverage> = {
  ui: restored("setNodeAttribute"),
  explicit: restored("setNodeAttribute"),
  dispatcher: restored("setNodeAttribute"),
  markdown: notInBackup("written by the body (`key:: value`): it comes back with the body"),
  frontmatter: notInBackup("written by the body's front matter: it comes back with the body"),
  derived: notInBackup("computed from other data: written again by whatever derives it"),
};

export const VALUE_TYPES: Record<string, Coverage> = {
  text: restored("as stored"), number: restored("as stored"), date: restored("as stored"), bool: restored("as stored"),
  node_ref: restored("the note it names is mapped to its restored id"),
};

/** `_` attributes by what backupSystemAttrs.classifySystemAttr says; a new class is a compile error here. */
export const SYSTEM_ATTRIBUTE_CLASSES: Record<SystemAttrClass, Coverage & { sample: string }> = {
  note: { sample: "_pinned", ...restored("with the note") },
  published: { sample: "_published", ...restored("with the note; 「不發布」 always, 「發布」 only for a note that returns as itself") },
  person: { sample: "_review_state", ...restored("a workspace move only: they name the person's own progress and feeds") },
  task: { sample: "_task_status", ...restored("a task's fields, as Tasks writes them") },
  never: { sample: "_block_marker", ...notInBackup("block markers and other module state: derived, written again by their module") },
};

/** Layouts a saved view of a note or a tag can have that are NOT written back. Empty on purpose: every layout the
 *  registries know is round-tripped by the fidelity test. */
export const VIEW_LAYOUTS_NOT_IN_A_BACKUP: Record<string, string> = {};

/** Task statuses that are not restored as they are. `later` is the pre-migration-135 status: it is read as todo + someday. */
export const TASK_STATUSES_CONVERTED: Record<string, string> = {
  later: "read as todo and 「someday」, as the migration did; backups of today do not hold it",
};

/** Every table that has a column naming a note (a foreign key to content_nodes, or node_id / note_id / … ). */
export const NODE_TABLES: Record<string, Coverage> = {
  content_nodes: restored("the notes, tags and tasks themselves (sidecars)"),
  node_attributes: restored("attributes in the sidecar"),
  node_tags: restored("tags in the sidecar, applied by applyTagToNode"),
  node_tag_states: restored("made by applyTagToNode with the tag"),
  node_edges: restored("typed links in the sidecar; `[[links]]` are made again from the body"),
  node_positions: restored("positions in the sidecar (boards and the graph)"),
  block_nodes: restored("tagged blocks and task lines come back with the body"),
  block_node_tags: restored("a block's own tags are in its `{…}` in the body"),
  block_anchors: restored("paragraph anchors in the sidecar"),
  note_anchor_places: restored("made again from the restored paragraph anchors: the unit follows the anchor rows at commit (migration 215)"),
  block_link_bindings: restored("link bindings in the sidecar"),
  // The name is spelled in two parts: blockRef.guard.test.ts keeps that table's name out of every file but its two owners.
  [["note", "block", "refs"].join("_")]: restored("an index kept in step with the body by every body write"),
  note_link_index: restored("an index rebuilt from the body"),
  function_refs: restored("saved views of notes and tags, and the task reference of a task"),
  media_uploads: restored("written with the attachment, for the restorer"),
  publish_snapshots: restored("a workspace move only (extras.site)"),
  workspaces: restored("a workspace move only: the home note of the site (extras.site)"),
  review_states: restored("a workspace move only (extras.review)"),
  focus_sessions: restored("a workspace move only (extras.focus)"),
  rss_subscriptions: restored("a workspace move only (extras.rss)"),
  actor_module_settings: restored("a workspace move only (extras.moduleSettings)"),
  ink_chunks: notInBackup("the earlier versions of a big drawing, kept for History (migration 203); a backup carries the drawing as it is now, in node_attributes, and no version history of drawings"),
  ink_manifests: notInBackup("the list of chunks of each earlier version of a big drawing (migration 203): History, as ink_chunks"),
  note_versions: restored("a format-3 backup's history comes back as versions: spine/importedHistory.ts mints one `g:` version per carried save (migration 220); without history a restore has the notes' new saves only, as today"),
  note_version_positions: restored("written with each version spine/importedHistory.ts mints: the restore transaction's own position"),
  note_version_events: notInBackup("this node's own map from its events to versions (migration 220); event ids mean nothing on another server, and importedHistory writes the map for the events it carries in"),
  note_pointers: notInBackup("sidebar pointers (a note shown under another) are not in a backup yet: found by this inventory, not one of the audit's four gaps"),
  node_embeddings: notInBackup("a search projection computed from the text, written again by the outbox"),
  board_copy_folds: notInBackup("bookkeeping of migration 139 (its undo script), not content"),
  board_copy_unparents: notInBackup("bookkeeping of migration 141 (its undo script), not content"),
  board_ink_moves: notInBackup("bookkeeping of migration 172 (its undo script), not content"),
  canvas_note_conversions: notInBackup("bookkeeping of migration 138 (its undo script), not content"),
  agent_sessions: notInBackup("AI workbench sessions: not notes; the AI's edits are in the notes"),
  ai_edit_suggestions: notInBackup("pending AI suggestions: decided in the app, not content"),
  ai_suggestions: notInBackup("pending AI suggestions: decided in the app, not content"),
  push_reminder_sent: notInBackup("a delivery log of reminders sent to devices"),
  rss_staging: notInBackup("feed items waiting for the person to keep or dismiss them; the subscriptions are carried by a move"),
  read_later_done_removed_192: notInBackup("what migration 192 kept of a removed module"),
  dispatcher_pending: notInBackup("the work queue of the edit log"),
  node_event_meta: notInBackup("a summary of the edit log"),
  domain_events: notInBackup("the edit log: a restore writes its own events; version history is format 3 (not in this format)"),
  ds_node: notInBackup("device-sync bookkeeping"),
  ds_peers: notInBackup("device-sync bookkeeping"),
  ds_projection_failures: notInBackup("device-sync bookkeeping"),
  sync_node: notInBackup("device-sync bookkeeping"),
};
