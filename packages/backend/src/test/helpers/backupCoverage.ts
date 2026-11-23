// What the backup carries, table by table (the one list; docs/architecture/backup-move.md). It lives with the tests because only a
// test reads it: the guard below fails when a table is missing from it.
//
// Anyone adding a table answers "does a backup carry it, and who puts it back?" here.
// src/test/guards/backupCoverage.guard.test.ts fails for a table that is not listed (a table that
// spine/syncClasses.json calls `derived` or `node-local` needs no entry: it is worked out again or belongs to one server,
// unless a backup carries it anyway, as `publish_snapshots` below) and for an entry whose table no longer exists. The
// restore side of a `carried` entry is the test that restores it: backupRoundTrip.property.test.ts and
// backupHostHop.property.test.ts compare what the app shows before and after.
//
// `carried.field` is a key of the type that holds it, so renaming or dropping the field breaks the build here.
// `missing` names what of a carried table is NOT in the archive. A `no` that is a gap (`gap: true`) is a loss a person could
// notice; a `no` that is not is on purpose, and says why. Both lists only shrink (the ratchet list in the guard test).

import type { BackupNote } from "../../services/backupArchive.js";
import type { BackupExtras } from "../../services/backupExtras.js";

export type BackupCarrier =
  /** A field of the note's own sidecar (`.onden/notes/<id>.json`). */
  | { by: "sidecar"; field: keyof BackupNote }
  /** A field of `.onden/extras.json`: the person's own state and the workspace's settings. Only a workspace move reads it, except `functionRefs` of the tags a restore makes. */
  | { by: "extras"; field: keyof BackupExtras }
  /** `.onden/spaces.json`: the spaces and their switches. */
  | { by: "spaces-file" }
  /** Worked out again from the note's text, which is carried. */
  | { by: "body" }
  /** The files in `attachments/` (named by the notes that use them). */
  | { by: "attachments" }
  /** Version history, `.onden/history/`, in a backup made with `?history=1`; only a workspace move reads it. */
  | { by: "history" };

export type BackupCoverage =
  | { carried: BackupCarrier; missing?: string }
  | { carried: "no"; why: string; gap: boolean };

const sidecar = (field: keyof BackupNote, missing?: string): BackupCoverage => ({ carried: { by: "sidecar", field }, ...(missing ? { missing } : {}) });
const extras = (field: keyof BackupExtras, missing?: string): BackupCoverage => ({ carried: { by: "extras", field }, ...(missing ? { missing } : {}) });
const left = (why: string, gap = false): BackupCoverage => ({ carried: "no", why, gap });

export const BACKUP_COVERAGE: Record<string, BackupCoverage> = {
  // ── The notes and what hangs off them ──
  content_nodes: sidecar("markdown"),
  node_attributes: sidecar("attributes"),
  node_tags: sidecar("tags"),
  node_edges: sidecar("edges"),
  note_pointers: sidecar("pointers"),
  node_positions: sidecar("positions"),
  block_anchors: sidecar("anchors"),
  note_anchor_places: sidecar("anchors"),
  block_link_bindings: sidecar("link_bindings"),
  block_node_tags: { carried: { by: "body" } },
  block_nodes: sidecar("anchors", "detached_note_id, detached_tags and hidden_at of a paragraph row (a paragraph made into its own note)"),
  function_refs: extras("functionRefs"),
  spaces: { carried: { by: "spaces-file" } },
  space_members: left("members are not rebuilt: a move says which spaces need inviting again (report.moved.need_reinvite)"),
  blobs: { carried: { by: "history" } },
  // A ?history=1 backup carries a note's text and title history; a workspace move mints these rows again from it
  // (spine/importedHistory.ts). Not carried: a drawing's earlier versions and their positions, the loss already listed
  // under ink_manifests / ink_chunks, and where each version was first written (the move records it as written here).
  note_versions: { carried: { by: "history" } },
  trash_groups: left("which notes went to the trash together; a restore deletes the backup's deleted notes again (services/backupRestore.ts), and those deletes write their own stamps and groups"),
  note_version_positions: { carried: { by: "history" } },
  media_uploads: { carried: { by: "attachments" } },
  // ── The person's own state (a workspace move) ──
  review_states: extras("review", "paragraph-level review progress"),
  focus_sessions: extras("focus"),
  actor_prefs: extras("prefs"),
  actor_module_settings: extras("moduleSettings"),
  rss_subscriptions: extras("rss"),
  rss_seen: left("which articles of a feed were read; the articles themselves are fetched again"),
  rss_mutes: left("muted feeds and keywords, with their expiry, are not in extras.json", true),
  external_calendars: left("calendar subscriptions (name, colour, on or off) are not carried; the address is encrypted with this server's secret", true),
  // ── The workspace ──
  workspaces: extras("modules", "time_zone, day_start_hour and home_node_id of the workspace"),
  publish_snapshots: extras("site"),
  // ── Left out ──
  ink_manifests: left("the earlier versions of a big drawing (chunked); the drawing as it is now is in the note's attributes", true),
  ink_chunks: left("the earlier versions of a big drawing (chunked); the drawing as it is now is in the note's attributes", true),
  imported_media: left("which files an import brought in already (a second import of the same file is not recognised)", true),
  snapshot_media: left("pictures a published page used; a move says the site must be published again", true),
  ai_suggestions: left("an old table of the removed API AI, unused (migration 149)"),
  ai_edit_suggestions: left("pending AI edit suggestions and what was decided about them", true),
  ai_edit_suggestion_items: left("pending AI edit suggestions and what was decided about them", true),
  read_later_done_removed_192: left("kept one release after the read-later feature was removed (migration 192)"),
  actors: left("accounts and who may sign in are not carried: a restore runs as the person who uploads it"),
  agent_tokens: left("credentials are never in a backup"),
  agent_runners: left("how this server runs AI sessions"),
  agent_session_events: left("the log of AI sessions on this server"),
  push_subscriptions: left("tied to a device"),
  push_reminder_sent: left("which reminders this server already pushed"),
  dispatcher_pending: left("a queue of background writes on this server"),
  event_reviews: left("marks on the operation log, which a backup does not carry (backup-move.md)"),
  member_removals: left("a guard of this server against a removed member signing in again"),
  owner_member_migration_log: left("what a one-time migration changed on this server"),
  board_copy_folds: left("a ledger of one-time migrations (139, 141)"),
  board_copy_unparents: left("a ledger of one-time migrations (139, 141)"),
  board_ink_moves: left("a ledger of one-time migrations (172, 179)"),
  canvas_note_conversions: left("a ledger of one-time migration 138"),
  ds_capture_cursor: left("device-to-device sync state of this server"),
  ds_captured_events: left("device-to-device sync state of this server"),
  ds_node: left("device-to-device sync state of this server"),
  ds_ops: left("device-to-device sync state of this server"),
  ds_peers: left("device-to-device sync state of this server"),
  ds_projection_failures: left("device-to-device sync state of this server"),
  ds_rejections: left("device-to-device sync state of this server"),
  ds_unsupported: left("device-to-device sync state of this server"),
};

/** The tables that have something a backup does not carry: a `no` that is a gap, and a carried table with a `missing`. */
export function backupGaps(): string[] {
  return Object.entries(BACKUP_COVERAGE).filter(([, c]) => (c.carried === "no" ? c.gap : c.missing !== undefined)).map(([table]) => table).sort();
}
