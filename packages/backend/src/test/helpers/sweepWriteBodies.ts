// One valid request per write route (crossWorkspaceWriteSweep.integration.test.ts).
//
// Key: "METHOD /path/:pattern", exactly as the router mounts it. Value: a function that, given workspace objects,
// returns the route's path params, query, headers and body — the smallest request that passes the route's own
// validation. Two object sets are passed so one table serves three passes:
//   own — fills the path params (what the caller addresses)
//   ref — fills the body/query fields that point at objects (what the body refers to)
// positive: own = ref = the caller's own objects (must succeed); cross-workspace: own = ref = A's;
// mixed: own = the caller's, ref = A's (a body that points out of the caller's workspace).
//
// Completeness is enforced by the test: a mounted write route without an entry fails it, and so does an entry
// that matches no mounted route.

import { SWEEP_API_KEY, type SweepObjects } from "./sweepWriteWorld.js";

export type SweepRequest = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  json?: unknown;
  /** multipart / raw bytes, for the routes that do not take JSON */
  raw?: { bytes: Uint8Array; contentType: string };
};
/** One request, or several when one route is many operations (POST /api/mcp/tools/:toolName: one per tool). */
export type SweepContent = (own: SweepObjects, ref: SweepObjects) => SweepRequest | SweepRequest[];

const HASH = "a".repeat(64);

/** A 1x1 PNG as the `file` part of a multipart body (the form POST /api/media takes). */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
function multipartPng(filename: string): { bytes: Uint8Array; contentType: string } {
  const boundary = "----sweepboundary";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { bytes: Buffer.concat([head, PNG_1X1, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const WRITE_CONTENT: Record<string, SweepContent> = {
  // ── nodes ────────────────────────────────────────────────────────────────
  "POST /api/nodes": (_o, r) => ({ json: { title: "Sweep new", markdown: "x", parent_id: r.note, tag_ids: [r.tag] } }),
  "PATCH /api/nodes/:id": (o, r) => ({ params: { id: o.note }, json: { title: "Sweep renamed", parent_id: r.otherNote } }),
  "DELETE /api/nodes/:id": (o) => ({ params: { id: o.child } }),
  "POST /api/nodes/:id/duplicate": (o) => ({ params: { id: o.note }, json: {} }),
  "POST /api/nodes/:id/undelete": (o) => ({ params: { id: o.trashed } }),
  "POST /api/nodes/:id/purge": (o, r) => ({ params: { id: o.trashed }, json: { expected_ids: [r.trashed] } }),
  "POST /api/nodes/:id/promote": (o) => ({ params: { id: o.child } }),
  "POST /api/nodes/:id/block-to-child": (o) => ({ params: { id: o.note }, json: { selection: { from: 0, to: o.canary.length + 4, text: `${o.canary}Body` } } }),
  "POST /api/nodes/:id/expand-child": (o, r) => ({ params: { id: o.note }, json: { child_id: r.child } }),
  "POST /api/nodes/:id/export-preview": (o) => ({ params: { id: o.note }, json: { title: "t", markdown: "m" } }),
  "POST /api/nodes/:id/views": (o) => ({ params: { id: o.note }, json: { name: "sweep view" } }),
  "PATCH /api/nodes/:id/views/:viewId": (o) => ({ params: { id: o.note, viewId: o.noteView }, json: { name: "renamed view" } }),
  "DELETE /api/nodes/:id/views/:viewId": (o) => ({ params: { id: o.note, viewId: o.noteView } }),
  "PUT /api/nodes/:id/attributes/:key": (o) => ({ params: { id: o.note, key: o.attrKey }, json: { value: "v", value_type: "text" } }),
  "DELETE /api/nodes/:id/attributes/:key": (o) => ({ params: { id: o.note, key: o.attrKey } }),
  "PUT /api/nodes/:id/position": (o) => ({ params: { id: o.note }, json: { surface: "graph", x: 1, y: 2 } }),
  "PUT /api/nodes/:id/tags/:tagId": (o, r) => ({ params: { id: o.otherNote, tagId: r.tag } }),
  "DELETE /api/nodes/:id/tags/:tagId": (o, r) => ({ params: { id: o.note, tagId: r.tag } }),
  "POST /api/nodes/:id/paragraphs/:blockId/reassign": (o, r) => ({ params: { id: o.note, blockId: r.child }, json: { at: 0, body_hash: HASH } }),

  // ── tags ─────────────────────────────────────────────────────────────────
  "POST /api/tags": (_o, r) => ({ json: { name: "sweeptagnew", parent_id: r.tag } }),
  "PATCH /api/tags/:id": (o) => ({ params: { id: o.tag }, json: { name: "sweeprenamed" } }),
  "PUT /api/tags/:id/extends": (o, r) => ({ params: { id: o.tag }, json: { extends: [r.moduleTag] } }),
  "PATCH /api/tags/:id/modules": (o) => ({ params: { id: o.tag }, json: { skills: true } }),
  "PATCH /api/tags/:id/schema": (o) => ({ params: { id: o.tag }, json: { fields: [] } }),
  "POST /api/tags/:sourceId/merge": (o, r) => ({ params: { sourceId: o.otherTag }, json: { target_id: r.tag } }),
  "POST /api/tags/:tagId/views": (o) => ({ params: { tagId: o.tag }, json: { name: "sweep view", layout: "list" } }),
  "PATCH /api/tags/:tagId/views/:viewId": (o) => ({ params: { tagId: o.tag, viewId: o.tagView }, json: { name: "renamed view" } }),
  "DELETE /api/tags/:tagId/views/:viewId": (o) => ({ params: { tagId: o.tag, viewId: o.tagView } }),
  "POST /api/tags/resolve-path": () => ({ json: { path: "sweep/path" } }),

  // ── links, pointers, whiteboards ─────────────────────────────────────────
  "POST /api/edges": (o, r) => ({ json: { source_node_id: o.note, target_node_id: r.otherNote, edge_type: "sweep_link" } }),
  "DELETE /api/edges/:id": (o) => ({ params: { id: o.edge } }),
  "POST /api/pointers": (o, r) => ({ json: { target_id: r.otherNote, parent_id: o.note } }),
  "POST /api/canvases": () => ({ json: { title: "Sweep canvas" } }),
  "PATCH /api/canvases/:id": (o) => ({ params: { id: o.canvas }, json: { title: "Sweep canvas renamed" } }),
  "DELETE /api/canvases/:id": (o) => ({ params: { id: o.canvas } }),
  "PATCH /api/boards/:id": (o, r) => ({ params: { id: o.canvas }, json: { cards: { upsert: [{ nodeId: r.note, x: 1, y: 1 }] } } }),

  // ── tasks ────────────────────────────────────────────────────────────────
  "POST /api/tasks": (_o, r) => ({ json: { title: "Sweep task", into: { note_id: r.note } } }),
  "PATCH /api/tasks/:id": (o) => ({ params: { id: o.task }, json: { status: "done" } }),
  "POST /api/tasks/:id/place": (o, r) => ({ params: { id: o.task }, json: { note_id: r.otherNote } }),
  "POST /api/tasks/:id/unplace": (o) => ({ params: { id: o.placedTask } }),
  "POST /api/nodes/:id/tasks": (o) => ({ params: { id: o.note }, json: { title: "Sweep hosted task" } }),
  "POST /api/tasks/focus": (_o, r) => ({ json: { task_id: r.task } }),

  // ── spaces ───────────────────────────────────────────────────────────────
  "POST /api/spaces": () => ({ json: { name: "Sweep space" } }),
  "PATCH /api/spaces/:id": (o) => ({ params: { id: o.space }, json: { name: "Sweep space renamed" } }),
  "DELETE /api/spaces/:id": (o) => ({ params: { id: o.space }, json: {} }),
  "PUT /api/spaces/:id/members/:actorId": (o, r) => ({ params: { id: o.space, actorId: r.member }, json: { permission: "view" } }),
  "DELETE /api/spaces/:id/members/:actorId": (o, r) => ({ params: { id: o.space, actorId: r.member } }),
  "POST /api/spaces/move": (o, r) => ({ json: { node_id: r.otherNote, to_space_id: o.space, membership_epoch: r.epoch } }),
  // ── workspace, preferences, push, query, sync ────────────────────────────
  "PATCH /api/workspace": (_o, r) => ({ json: { home_node_id: r.note } }),
  "PATCH /api/workspace/time": () => ({ json: { day_start_hour: 3 } }),
  "PATCH /api/workspace/config": () => ({ json: { config: {} } }),
  "PATCH /api/workspace/modules": () => ({ json: { module: "review", imported: true } }),
  "PUT /api/me/prefs/:key": () => ({ params: { key: "nav" }, json: { value: { order: ["home"], phone: 0 } } }),
  "POST /api/push/subscriptions": () => ({ json: { endpoint: "https://push.example.test/sweep", p256dh: "k", auth: "a" } }),
  "DELETE /api/push/subscriptions": () => ({ json: { endpoint: "https://push.example.test/sweep" } }),
  "POST /api/query": (_o, r) => ({ json: { tags: [r.tag], limit: 5 } }),
  "POST /api/sync": (_o, r) => ({ json: { since: 0, known: [r.note] } }),
  "POST /api/sync/bodies": (_o, r) => ({ json: { ids: [r.note] } }),
  "POST /api/sync/drawings": (_o, r) => ({ json: { ids: [r.note] } }),
  "POST /api/sync/nodes": (_o, r) => ({ json: { ids: [r.note, r.child] } }),
  "POST /api/capture/inbox": () => ({}),

  // ── history, events, versions, pointers ──────────────────────────────────
  "POST /api/events/:event_id/restore": (o) => ({ params: { event_id: o.deleteEvent }, json: {} }),
  "POST /api/nodes/:id/versions/:versionId/restore": (o) => ({ params: { id: o.note, versionId: o.event }, json: {} }),
  "DELETE /api/pointers/:id": (o) => ({ params: { id: o.pointer } }),

  // ── tasks (focus), review ────────────────────────────────────
  "PATCH /api/tasks/focus/:id": (o) => ({ params: { id: o.focus }, json: { note: "sweep" } }),
  "POST /api/tasks/focus/:id/end": (o) => ({ params: { id: o.focus }, json: {} }),
  "POST /api/review/:nodeId/grade": (o) => ({ params: { nodeId: o.reviewNote }, json: { rating: 3 } }),
  "POST /api/review/:nodeId/undo-grade": (o) => ({ params: { nodeId: o.reviewNote }, json: {} }),
  "PUT /api/review/cards/:nodeId": (o) => ({ params: { nodeId: o.note } }),
  "DELETE /api/review/cards/:nodeId": (o) => ({ params: { nodeId: o.note } }),
  "POST /api/review/:nodeId/tomorrow": (o) => ({ params: { nodeId: o.reviewNote }, json: {} }),
  "POST /api/review/:nodeId/suspend": (o) => ({ params: { nodeId: o.reviewNote }, json: {} }),
  "POST /api/review/:nodeId/resume": (o) => ({ params: { nodeId: o.reviewNote }, json: {} }),
  "PUT /api/review/settings/:tagId": (o) => ({ params: { tagId: o.tag }, json: { maximum_interval_days: 5 } }),
  "PATCH /api/review/settings/:tagId": (o) => ({ params: { tagId: o.tag }, json: { maximum_interval_days: 6 } }),
  "DELETE /api/review/settings/:tagId": (o) => ({ params: { tagId: o.tag } }),

  // ── RSS (reads of the local database only; the routes that fetch a feed are in NO_POSITIVE) ──
  "POST /api/rss/items/:id/seen": (o) => ({ params: { id: o.article }, json: {} }),
  "POST /api/rss/items/:id/save": (o) => ({ params: { id: o.article }, json: {} }),
  "POST /api/rss/sources/:id/unsubscribe": (o) => ({ params: { id: o.feed }, json: {} }),
  "PATCH /api/rss/sources/:id": (o) => ({ params: { id: o.feed }, json: { always_fulltext: true } }),

  // ── agent tools ──────────────────────────────────────────────────────────
  "POST /api/mcp/tools/:toolName": (o, r) => [
    { params: { toolName: "updateNode" }, json: { id: o.note, title: "Sweep tool rename" } },
    { params: { toolName: "createNode" }, json: { title: "Sweep tool note", parent_id: r.note, tag_ids: [r.tag] } },
    { params: { toolName: "applyTag" }, json: { nodeId: o.otherNote, tagId: r.tag } },
    { params: { toolName: "removeTag" }, json: { nodeId: o.note, tagId: r.tag } },
    { params: { toolName: "commentOnNote" }, json: { id: r.note, text: "sweep comment" } },
    { params: { toolName: "setSlideLayout" }, json: { id: o.note, theme: "dark" } },
  ],
  // ── people and tokens ────────────────────────────────────────────────────
  "POST /api/actors": () => ({ json: { name: "Sweep agent", type: "agent" } }),
  "PATCH /api/actors/:id": (o) => ({ params: { id: o.member }, json: { name: "Sweep renamed" } }),
  "DELETE /api/actors/:id": (o) => ({ params: { id: o.member } }),
  "POST /api/actors/:id/invite": (o) => ({ params: { id: o.member } }),
  "POST /api/actors/:id/tokens": (o) => ({ params: { id: o.member }, json: { name: "sweep token", access: "read" } }),
  "PATCH /api/actors/:id/tokens/:tokenId": (o) => ({ params: { id: o.member, tokenId: o.memberToken }, json: { access: "write" } }),
  "POST /api/actors/:id/tokens/:tokenId/revoke": (o) => ({ params: { id: o.member, tokenId: o.memberToken } }),
  "DELETE /api/actors/:id/tokens/:tokenId": (o) => ({ params: { id: o.member, tokenId: o.memberToken } }),
  "POST /api/invites/claim": () => ({ json: {} }),

  // ── tag functions, history, feeds, uploads ────────────────────
  "PUT /api/tags/:id/functions/:functionId": (o) => ({ params: { id: o.tag, functionId: "skills" }, json: {} }),
  "PATCH /api/tags/:id/functions/:functionId": (o) => ({ params: { id: o.fnTag, functionId: "skills" }, json: { config: {} } }),
  "DELETE /api/tags/:id/functions/:functionId": (o) => ({ params: { id: o.fnTag, functionId: "skills" } }),
  "POST /api/history/deleted/purge": (o, r) => ({ json: { items: [{ node_id: o.trashed, expected_ids: [r.trashed] }] } }),
  "POST /api/rss/mutes": (_o, r) => ({ json: { source_id: r.feed } }),
  "PUT /api/rss/source-space": (_o, r) => ({ json: { space_id: r.space } }),
  "POST /api/nodes/:id/suggested-links": (o) => ({ params: { id: o.note } }),
  "POST /api/media": () => ({ raw: multipartPng("sweep.png") }),
  // ── AI: keys, roles, runners ─────────────────────────────────────────────
  "POST /api/ai/credentials": () => ({ json: { label: "sweep key", api_key: SWEEP_API_KEY, base_url: "https://api.example.test/v1", protocol: "v1_messages" } }),
  "DELETE /api/ai/credentials/:id": (o) => ({ params: { id: o.credential } }),
  "POST /api/ai/credentials/test": () => ({ json: { api_key: SWEEP_API_KEY, base_url: "https://api.example.test/v1", protocol: "v1_messages" } }),
  "POST /api/ai/credentials/:id/test": (o) => ({ params: { id: o.credential } }),
  "POST /api/ai/roles": (o) => ({ json: { name: "sweep ai", connection: { kind: "api", credential_id: o.credential, model: "test-model", cap: { kind: "unlimited" } } } }),
  "PATCH /api/ai/roles/:actor_id": (o) => ({ params: { actor_id: o.agent }, json: { review_rule: "suggest" } }),
  "PUT /api/ai/roles/:actor_id/runtime": (o, r) => ({ params: { actor_id: o.agent }, json: { api: { credential_id: r.credential } } }),
  "PUT /api/agent-sessions/runners/:actor_id": (o) => ({ params: { actor_id: o.agent }, json: { handle: `sweep${o.handle}` } }),
  "POST /api/agent-sessions/runners/:actor_id/enabled": (o) => ({ params: { actor_id: o.agent }, json: { enabled: false } }),
  "POST /api/history/rewind": (_o, r) => ({ json: { t: new Date().toISOString(), restore_ids: [r.note], undelete_ids: [], delete_ids: [] } }),
  // ── ownership, chat, calls out to other servers ──────────────────────────
  "POST /api/workspace/owner-transfer": (o, r) => ({ json: { to_actor_id: r.member, confirm_name: `${r.canary}Member` } }),
  "DELETE /api/ai/panel-chat/:nodeId": (o) => ({ params: { nodeId: o.aiNote } }),
  "POST /api/ai/panel-chat": (o, r) => ({ json: { agent_actor_id: r.agent, node_id: r.aiNote, text: "sweep hello", request_id: "11111111-1111-4111-8111-111111111111" } }),
  "POST /api/ai/selection-actions": (o, r) => ({ json: { agent_actor_id: r.agent, node_id: r.aiNote, skill: "explain", text: "please tidy this too", request_id: "22222222-2222-4222-8222-222222222222" } }),
  "POST /api/agent-sessions": (_o, r) => ({ json: { node_id: r.note, block_text: "sweep block" } }),
  "POST /api/bookmark/preview": () => ({ json: { url: "https://example.test/sweep" } }),
  "POST /api/bookmark": () => ({ json: { url: "https://example.test/sweep" } }),
  "POST /api/rss/subscribe": () => ({ json: { url: "https://feed.test/sweep-new.xml" } }),
  "POST /api/rss/sources/:id/refresh": (o) => ({ params: { id: o.feed }, json: {} }),
  "POST /api/rss/items/:id/fulltext": (o) => ({ params: { id: o.article }, json: {} }),
  "POST /api/nodes/:id/block-links": (o, r) => ({ params: { id: o.note }, json: { source_note_id: r.child, at: 0, seen_text: `${r.canary}ChildBody` } }),
  // ── agent sessions, AI suggestions ───────────────────────────────────────
  "POST /api/agent-sessions/:id/cancel": (o) => ({ params: { id: o.session }, json: {} }),
  "POST /api/agent-sessions/:id/insert-reply": (o) => ({ params: { id: o.session }, json: {} }),
  "POST /api/agent-sessions/:id/revert": (o) => ({ params: { id: o.endedSession }, json: {} }),
  "POST /api/ai-suggestions/:id/accept": (o) => ({ params: { id: o.suggestion }, json: { item_ids: "all" } }),
  "POST /api/ai-suggestions/:id/reject": (o) => ({ params: { id: o.suggestion }, json: { item_ids: "all" } }),
  // The runner's side: the caller must be the agent's own token, which the sweep (it signs in as the workspace owner) is not.
  "POST /api/mcp/sessions/:id/claim": (o) => ({ params: { id: o.session }, json: {} }),
  "POST /api/mcp/sessions/:id/events": (o) => ({ params: { id: o.session }, json: { seq: 0, kind: "ack" } }),
  "POST /api/mcp/sessions/:id/finish": (o) => ({ params: { id: o.session }, json: { status: "failed", fail_code: "sweep" } }),

  // ── backup and restore ───────────────────────────────────────────────────
  "POST /api/fresh-proof": () => ({ json: { purpose: "snapshot_export", evidence: { kind: "acknowledgement" } } }),
  "POST /api/snapshot": () => ({ raw: { bytes: Buffer.from('{"kind":"hello","dataShape":1,"workspaceId":"00000000-0000-4000-8000-000000000001","source":"sweep-source","cut":0,"person":"00000000-0000-4000-8000-000000000002"}\n'), contentType: "application/x-ndjson" } }),
  "POST /api/backup/restore/upload": (o) => ({ raw: { bytes: Buffer.from(o.backupZipBase64, "base64"), contentType: "application/zip" } }),
  "POST /api/backup/restore/:id/apply": (o, r) => ({ params: { id: o.upload }, json: { space_id: r.space, mode: "empty" } }),
  "DELETE /api/backup/restore/:id": (o) => ({ params: { id: o.upload } }),

  // ── events, calendars ─────────────────────────────────────────
  "POST /api/events/:event_id/revert-conflict": (o) => ({ params: { event_id: o.conflictEvent }, json: {} }),
  "POST /api/external-calendars": () => ({ json: { name: "Sweep calendar", color: "#336699", url: "https://calendar.test/sweep.ics" } }),
  "PATCH /api/external-calendars/:id": (o) => ({ params: { id: o.calendar }, json: { name: "Sweep calendar renamed" } }),
  "DELETE /api/external-calendars/:id": (o) => ({ params: { id: o.calendar } }),
  "POST /api/external-calendars/:id/refresh": (o) => ({ params: { id: o.calendar }, json: {} }),

  // ── history: undoing a rewind or an agent's run ──────────────────────────
  "POST /api/history/rewinds/:rewindId/undo": (o, r) => ({ params: { rewindId: o.rewindId }, json: { node_ids: [r.rewindNote] } }),
  "POST /api/history/agent-runs/:runId/undo": (o, r) => ({ params: { runId: o.agentRun }, json: { node_ids: [r.agentNote] } }),
  "POST /api/history/agent-runs/:runId/redo": (o, r) => ({ params: { runId: o.agentRun }, json: { node_ids: [r.agentNote] } }),
  "POST /api/nodes/:id/ink-versions/:eventId/restore": (o) => ({ params: { id: o.note, eventId: o.inkEvent }, json: {} }),
  "POST /api/nodes/:id/block-anchors/:anchorId/confirm": (o) => ({ params: { id: o.note, anchorId: "k3q9" }, json: {} }),

  // ── inbox ────────────────────────────────────────────────────────────────
  "POST /api/inbox/:event_id/:decision{approve|reject}": (o) => ({ params: { event_id: o.agentEvent, decision: "reject" }, json: {} }),
  "POST /api/inbox/groups/:root_event_id/:decision{approve|reject}": (o) => ({ params: { root_event_id: o.agentEvent, decision: "approve" }, json: {} }),
  "POST /api/inbox/batch": (_o, r) => ({ json: { decision: "approve", event_ids: [r.agentEvent] } }),
  "POST /api/inbox/approvals/:id/:decision{approve|reject}": (o) => ({ params: { id: o.approval, decision: "approve" }, json: {} }),
  "POST /api/inbox/failed-effects/:id/retry": (o) => ({ params: { id: o.deadEffect }, json: {} }),
  "POST /api/inbox/failed-effects/kinds/:kind/:action{retry|dismiss}": (o) => [
    { params: { kind: o.deadKind, action: "retry" }, json: {} },
    { params: { kind: o.deadKind, action: "dismiss" }, json: {} },
  ],

  // ── publishing, previews, imports ────────────────────────────────────────
  "POST /api/preview": () => ({ json: {} }),
  "POST /api/publish/preview": (_o, r) => ({ json: { title: "Sweep site", home_node_id: r.note } }),
  "POST /api/publish/include": (_o, r) => ({ json: { noteIds: [r.note] } }),
  "POST /api/publish/keep-off-subtree": (_o, r) => ({ json: { noteId: r.note } }),
  "POST /api/publish": (_o, r) => ({ json: { title: "Sweep site", home_node_id: r.note } }),
  "POST /api/import/obsidian": () => ({ json: { files: [{ path: "sweep/Imported.md", content: "# Imported\n\nsweep body" }] } }),
  "POST /api/tags/import": (o) => ({ json: { name: `sweepimport${o.canary.toLowerCase()}`, description: "a pack", fields: [] } }),
  "POST /api/review/blocks/:blockId/grade": (o) => ({ params: { blockId: o.block }, json: { rating: 3 } }),
  "POST /api/review/blocks/:blockId/undo-grade": (o) => ({ params: { blockId: o.block }, json: {} }),
  "POST /api/review/blocks/:blockId/tomorrow": (o) => ({ params: { blockId: o.block }, json: {} }),
  "POST /api/review/blocks/:blockId/suspend": (o) => ({ params: { blockId: o.block }, json: {} }),
  "POST /api/review/blocks/:blockId/resume": (o) => ({ params: { blockId: o.block }, json: {} }),
  "DELETE /api/rss/mutes/:id": (o) => ({ params: { id: o.mute } }),
  "POST /api/rss/opml": () => ({ json: { opml: '<?xml version="1.0"?><opml version="2.0"><body><outline text="Sweep" xmlUrl="https://feed.test/sweep-opml.xml"/></body></opml>' } }),
};

/** Routes whose request cannot succeed inside the test, each with the reason. Only shrinks (ratchet). */
// ratchet:list sweepWriteNoPositive
export const NO_POSITIVE: Array<{ route: string; reason: string }> = [
  { route: "POST /api/fresh-proof", reason: "needs an account with a password: this sweep runs with a stand-in for the sign-in library that has none, so the only answer here is 403 fresh_proof_no_password; the granted case is in freshProof.integration.test.ts with a real account" },
  { route: "POST /api/nodes/:id/block-links", reason: "answers 409 'the part changed': it checks the posted text against a paragraph of the source note at that offset, which the world's one-line notes do not give (the request passes validation, so the cross passes reach the lookup)" },
  { route: "POST /api/agent-sessions", reason: "needs a note whose text holds an @mention of the agent's handle at the given block; the world's notes have none" },
  { route: "POST /api/bookmark/preview", reason: "fetches the page at the URL: the test has no network" },
  { route: "POST /api/bookmark", reason: "fetches the page at the URL: the test has no network" },
  { route: "POST /api/rss/subscribe", reason: "fetches the feed at the URL: the test has no network" },
  { route: "POST /api/rss/sources/:id/refresh", reason: "fetches the feed: the test has no network" },
  { route: "POST /api/rss/items/:id/fulltext", reason: "fetches the article's page: the test has no network" },
  { route: "POST /api/actors/:id/invite", reason: "only a person who has not signed in yet has an invite link (409 invite_not_pending); the world's member is signed in" },
  { route: "POST /api/invites/claim", reason: "claims an invite for a signed-in outsider; the caller here is already the workspace's owner (409 already_member)" },
  { route: "POST /api/push/subscriptions", reason: "answers 404 push_not_configured: the test deployment has no VAPID keys" },
  { route: "DELETE /api/push/subscriptions", reason: "answers 404 push_not_configured: the test deployment has no VAPID keys" },
  { route: "POST /api/review/:nodeId/undo-grade", reason: "undoes the caller's last grade, and the world has none (grading it first would need the caller's session clock); the cross passes reach the lookup" },
  { route: "POST /api/tasks/focus/:id/end", reason: "ends a RUNNING session, and a person has one running at a time: a running one in the world would make POST /api/tasks/focus (same caller) a 409. The cross passes still reach the lookup (the request is valid)" },
  { route: "POST /api/nodes/:id/expand-child", reason: "needs a note whose body is exactly one embed line of its child; the sweep world has none (the request is otherwise valid, so the cross passes reach the lookup)" },
  { route: "POST /api/nodes/:id/paragraphs/:blockId/reassign", reason: "needs a block row (a paragraph anchor) with a matching body hash; the world has none" },
  { route: "POST /api/mcp/sessions/:id/claim", reason: "the runner's side: only the agent's own resident token may pull a session (403 for a person); the sweep signs in as the workspace owner, so it can only see the refusal" },
  { route: "POST /api/mcp/sessions/:id/events", reason: "the runner's side: only the session token minted by claim may log to a session (403 'does not belong to this session'); the sweep signs in as the workspace owner" },
  { route: "POST /api/snapshot", reason: "fills only an EMPTY workspace of its own (409 join_not_empty: the sweep's workspaces hold notes); the request names nothing of A and writes nothing when refused. The positive case (200, two digests agree, the workspace is the database's) is src/test/stampedSnapshotTwoProcess.integration.test.ts, on real Postgres and PGlite, and the two-node PGlite route test in stampedSnapshot.integration.test.ts" },
  { route: "POST /api/mcp/sessions/:id/finish", reason: "the runner's side: only the session token minted by claim may finish a session (403); the sweep signs in as the workspace owner" },
];

/** Routes that ask another server and answer 502 when it cannot be reached: the test has no network. The sweep
 *  accepts exactly 502 from these (any other 5xx still fails). Only shrinks. */
// ratchet:list sweepWriteNetwork502
export const NETWORK_502: Array<{ route: string; reason: string }> = [];

/** Mounted write routes that have no request above yet: the sweep still aims the generic body at them. Only shrinks. */
// ratchet:list sweepWriteNoContentYet
export const NO_CONTENT_YET: string[] = [];
