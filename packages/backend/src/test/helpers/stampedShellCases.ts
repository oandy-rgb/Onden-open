// What makes a database "not an empty shell" (spine/joinShell.ts), one case per kind of thing a person puts in it. Each case adds ONE
// thing to a fresh database and says which table (or "stamp") must be what the check names; the cases are run in a transaction that
// is rolled back, one after another, in the database of a process (scripts/stamped-snapshot-process.mts `shells`) so the same cases run
// on PGlite and on a real Postgres. stampedSnapshotProcesses.integration.test.ts checks that every table the snapshot carries and every
// table that shellHolds lists has a case, or an exemption with its reason below.
import { randomUUID } from "node:crypto";
import { seedQ } from "./seedQ.js";
import { makeSpace } from "./spaceFixtures.js";

export type ShellCtx = { ws: string; caller: string; defaultSpace: string; systemActor: string | null; tag: (title: string) => Promise<string>; siteConfig: () => Promise<string> };
export type ShellCase = { name: string; reason: string; seed: (c: ShellCtx) => Promise<void> };

const uuid = () => randomUUID();
const note = async (c: ShellCtx, title: string): Promise<void> => {
  await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, 'manual', 'content', $3, $4, 'body', $5)`,
    [uuid(), c.ws, title, `s-${uuid()}`, c.defaultSpace]);
};

export const SHELL_CASES: ShellCase[] = [
  { name: "a note the person wrote", reason: "content_nodes", seed: (c) => note(c, "Mine") },
  { name: "a tag the person made, stamped genesis the way an older database's rows are", reason: "content_nodes", seed: async (c) => {
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, tag_schema) VALUES ($1, $2, 'manual', 'class_tag', 'my-own-tag', 'my-own-tag', '{"fields": []}'::jsonb)`, [uuid(), c.ws]);
    await seedQ(`SELECT * FROM sync_genesis_pass()`);
  } },
  { name: "a built-in tag applied to the Site Config note", reason: "node_tags", seed: async (c) => { await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [await c.siteConfig(), await c.tag("book")]); } },
  { name: "an attribute a person set", reason: "node_attributes", seed: async (c) => { await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'x', 'y', 'ui')`, [c.ws, await c.tag("book")]); } },
  { name: "a link a person drew", reason: "node_edges", seed: async (c) => { await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'relates_to', 'active', 'manual')`, [c.ws, await c.tag("book"), await c.tag("task")]); } },
  { name: "a pointer", reason: "note_pointers", seed: async (c) => { await seedQ(`INSERT INTO note_pointers (workspace_id, parent_id, target_id) VALUES ($1, $2, $3)`, [c.ws, await c.tag("book"), await c.tag("task")]); } },
  { name: "a card position", reason: "node_positions", seed: async (c) => { await seedQ(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'graph', 1, 2, $2)`, [await c.tag("book"), c.ws]); } },
  { name: "a block", reason: "block_nodes", seed: async (c) => { await seedQ(`INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind, text_cache) VALUES ($1, $2, $3, 'b1', 'paragraph', 'text')`, [uuid(), c.ws, await c.tag("book")]); } },
  { name: "a function reference", reason: "function_refs", seed: async (c) => { await seedQ(`INSERT INTO function_refs (id, workspace_id, function_id, holder_space_id, config) VALUES ($1, $2, 'view', $3, '{}'::jsonb)`, [uuid(), c.ws, c.defaultSpace]); } },
  { name: "a person's module settings", reason: "actor_module_settings", seed: async (c) => { await seedQ(`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"on": true}'::jsonb)`, [c.caller, await c.tag("book")]); } },
  { name: "a space", reason: "spaces", seed: async (c) => { await makeSpace(c.ws, "Mine", []); } },
  { name: "a feed", reason: "rss_subscriptions", seed: async (c) => { await seedQ(`INSERT INTO rss_subscriptions (id, workspace_id, space_id, title, url, created_by_actor_id) VALUES ($1, $2, $3, 'Feed', 'https://example.test/feed.xml', $4)`, [uuid(), c.ws, c.defaultSpace, c.caller]); } },
  { name: "a muted word", reason: "rss_mutes", seed: async (c) => { await seedQ(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, $2, 'spoiler', now() + interval '1 day')`, [c.ws, c.caller]); } },
  { name: "a calendar", reason: "external_calendars", seed: async (c) => { await seedQ(`INSERT INTO external_calendars (id, workspace_id, actor_id, name, color, url_ciphertext, url_host) VALUES ($1, $2, $3, 'Cal', '#336699', '\\x0102'::bytea, 'cal.example.test')`, [uuid(), c.ws, c.caller]); } },
  { name: "review progress (a table with no stamp trigger yet)", reason: "review_states", seed: async (c) => { await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state, previous_state) VALUES ($1, $2, $3, 'learning', 'new')`, [c.ws, await c.tag("book"), c.caller]); } },
  { name: "a preference (no stamp trigger yet)", reason: "actor_prefs", seed: async (c) => { await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"dark"'::jsonb)`, [c.caller]); } },
  { name: "a focus session (no stamp trigger yet)", reason: "focus_sessions", seed: async (c) => { await seedQ(`INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at, ended_at, note) VALUES ($1, $2, $3, $4, now() - interval '1 hour', now(), 'work')`, [uuid(), c.ws, c.caller, await c.tag("book")]); } },
  { name: "a paragraph anchor (no stamp trigger yet)", reason: "block_anchors", seed: async (c) => { await seedQ(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, kind, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, 'a1', $2, 'range', 0, 2, 'h', 'qu')`, [c.ws, await c.tag("book")]); } },
  { name: "an AI suggestion waiting for a decision", reason: "ai_edit_suggestions", seed: async (c) => {
    if (!c.systemActor) throw new Error("no System account to write the suggestion as");
    await seedQ(`INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, base_markdown, base_title, proposal_hash, created_event_id) VALUES ($1, $2, $3, $4, $5, 'old', 'T', 'ph', 1)`, [uuid(), c.ws, c.defaultSpace, await c.tag("book"), c.systemActor]);
  } },
  { name: "a second person", reason: "actors", seed: async (c) => { await seedQ(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1, $2, 'Second', 'human')`, [uuid(), c.ws]); } },
  { name: "an agent that is not the System account", reason: "actors", seed: async (c) => { await seedQ(`INSERT INTO actors (id, workspace_id, name, type, external_id) VALUES ($1, $2, 'Bot', 'agent', 'bot-1')`, [uuid(), c.ws]); } },
  { name: "a module switch changed", reason: "workspaces", seed: async (c) => { await seedQ(`UPDATE workspaces SET modules_off = '["review"]'::jsonb WHERE id = $1`, [c.ws]); } },
  { name: "a saved view stamped by a person's write", reason: "stamp", seed: (c) => personStamp(c, "content_nodes.collection_views", "view:v1") },
  { name: "a tag field stamped by a person's write", reason: "stamp", seed: (c) => personStamp(c, "content_nodes.tag_schema", "field:f1") },
  { name: "a space switch stamped by a person's write", reason: "stamp", seed: (c) => personStamp(c, "spaces.capabilities", "switch:publish") },
  { name: "a module switch stamped by a person's write", reason: "stamp", seed: (c) => personStamp(c, "workspaces.modules_off", "off:review") },
  { name: "a token", reason: "agent_tokens", seed: async (c) => { await seedQ(`INSERT INTO agent_tokens (actor_id, token_hash, name, access) VALUES ($1, 'h', 'mine', 'read')`, [c.systemActor ?? c.caller]); } },
  { name: "an AI connection", reason: "ai_credentials", seed: async (c) => { await seedQ(`INSERT INTO ai_credentials (workspace_id, label, protocol, base_url, secret_ciphertext, secret_last4, created_by) VALUES ($1, 'k', 'v1_messages', 'https://x.test', '\\x01'::bytea, '1234', $2)`, [c.ws, c.caller]); } },
  { name: "an uploaded file", reason: "blobs", seed: async () => { await seedQ(`INSERT INTO blobs (hash, content, size_bytes) VALUES ('h1', 'c', 1)`); } },
  { name: "a push subscription", reason: "push_subscriptions", seed: async (c) => { await seedQ(`INSERT INTO push_subscriptions (workspace_id, actor_id, endpoint, p256dh, auth) VALUES ($1, $2, 'https://push.test/1', 'p', 'a')`, [c.ws, c.caller]); } },
];

/** What a write that went through mutate() leaves: a stamp of this node with an author. */
async function personStamp(c: ShellCtx, label: string, field: string): Promise<void> {
  await seedQ(
    `INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
     VALUES ($1, $2, $3, $4, 'some-node', 5, 1700000000000, 0, $5, NULL, false)`, [c.ws, label, c.ws, field, c.caller]);
}

/** Tables the snapshot carries (or lists as must-be-empty) that have no case of their own, and why. */
// ratchet:list SHELL_CASE_EXEMPTIONS
export const NO_OWN_SHELL_CASE: Record<string, string> = {
  space_members: "an install's membership rows (the System account's and the signed-in person's seats) are allowed and nothing else can be added without a space or a person of its own, which have their cases",
  block_node_tags: "needs a block, whose own case (block_nodes) is refused first",
  rss_staging: "needs a feed, whose own case (rss_subscriptions) is refused first",
  rss_seen: "needs a staged article, which needs a feed",
  block_link_bindings: "needs a paragraph anchor, whose own case (block_anchors) is refused first",
  ai_edit_suggestion_items: "needs a suggestion, whose own case (ai_edit_suggestions) is refused first",
  agent_runners: "the same check as the other must-be-empty tables (one SELECT per table in spine/joinShell.ts); agent_tokens, ai_credentials, blobs and push_subscriptions stand for them",
  agent_sessions: "see agent_runners", agent_session_events: "see agent_runners", ai_suggestions: "see agent_runners", media_uploads: "see agent_runners",
  imported_media: "see agent_runners", snapshot_media: "see agent_runners", publish_snapshots: "see agent_runners", backup_restore_jobs: "see agent_runners",
  event_reviews: "see agent_runners", member_removals: "see agent_runners", dispatcher_pending: "see agent_runners", push_reminder_sent: "see agent_runners",
  board_copy_folds: "see agent_runners", board_copy_unparents: "see agent_runners", board_ink_moves: "see agent_runners", canvas_note_conversions: "see agent_runners",
  ds_peers: "see agent_runners", ds_ops: "see agent_runners",
};
