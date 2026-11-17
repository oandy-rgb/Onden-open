// Spine gate — the by-construction backstop.
//
// HTTP routes must perform mutations through the spine's mutate(), which
// guarantees (and the demo-user/attribution bugs proved we can't guarantee by
// discipline alone): an actor is present, authority is checked first, a
// domain_event is always emitted, its actor_type is DERIVED (un-forgeable), and
// event + state commit atomically.
//
// A raw db `event()` call inside a route bypasses all of that. There is no
// eslint in this package, so this test IS the gate: it fails when a route emits
// a raw event() outside the allowlist below. To make it pass you almost always
// want mutate() instead. The few entries here are deliberate, justified
// exceptions (genuine system events / external effects), each with a reason — a
// NEW raw event() in a route is a regression, not a license to extend the list.
//
// (The dispatcher cascade + restore engine + agent tools legitimately emit via
// event() and are out of scope here — they run *inside* a mutate() cascade or
// are the spine's own machinery. This gate guards the HTTP entry boundary.)

import { describe, it, expect } from "vitest";
import { sqlWritesIn } from "./helpers/sqlWrites.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROUTE_RAW_EVENT_ALLOWLIST: Record<string, number> = {
  // (nodes.ts retired: ATTRIBUTE_CONFLICT moved to services/attributeWrites.ts
  // and BODY_CONFLICT to services/nodeUpdate.ts — spineEventGate covers both.)
  // (tags.ts retired: the pack import's TAG_DEPENDENCY_MISSING moved with it
  // to services/tagPacks.ts installTagPack, D13.)
  // (rss.ts retired: the rebuilt RSS module — src/modules/rss — mutates
  // through the spine; migration 061 dropped its legacy tables.)
  // (tasks.ts allowlist retired with migration 062: the recurring-task mint is
  // now a NESTED spine createTaskNode() inside the completion's mutate(), so
  // its NODE_CREATED is attributed + chained by construction — no raw event().)
};

// Raw mutation SQL in routes: since D2 a route writes nothing itself — the
// service that owns the row does, inside its mutate() (eslint onden/
// no-route-writes, eslint-rules/no-route-writes.js, with an empty allowlist).
// The coarse "a writing route calls mutate()" net below is now "no route
// writes"; the services it moved into are covered by the pool.query gate and
// the module gates further down.
const MUTATION_SQL = /INSERT INTO|UPDATE \w+ SET|DELETE FROM/i;

// Precise complement to the coarse mutate()-presence check below. A mutation run
// via pool.query() (rather than the tx-aware q()) CANNOT join mutate()'s open
// transaction — so it is, provably, not atomic with any spine event and not
// inside the spine at all. We freeze the count of such calls per file at an
// exact allowlist (like the event() gate): a NEW pool.query mutation anywhere
// fails the build, and the existing debt is enumerated, not hidden. Drive the
// number DOWN by migrating writes onto the spine; never up.
const POOL_MUTATION = /pool\.query\b[^;]{0,120}?(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM)/g;
const ROUTE_POOL_MUTATION_ALLOWLIST: Record<string, number> = {
  // (rss.ts retired with the module rebuild — the list is EMPTY: every
  // mutating route is spine-migrated. Keep it that way.)
};

const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
const modulesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "modules");

// Module files are scanned with the SAME gates as routes/ (the README's
// "extend the gate to modules/*/ when the second module lands" — this is the
// second module). Keys are "<moduleId>/<file>". Pure unit-test files are
// excluded (they don't run in the server).
function moduleSourceFiles(): Array<{ key: string; path: string }> {
  const out: Array<{ key: string; path: string }> = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of readdirSync(join(modulesDir, entry.name))) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      out.push({ key: `${entry.name}/${f}`, path: join(modulesDir, entry.name, f) });
    }
  }
  return out;
}

const MODULE_RAW_EVENT_ALLOWLIST: Record<string, number> = {
  // (PREVIEW_GENERATED now rides mutate(); PUBLISH_SNAPSHOT_CREATED lives in
  // modules/website/publishing/snapshot.ts, spineEventGate's import allowlist.)
};
const MODULE_RAW_MUTATION_ALLOWLIST: Record<string, string> = {
  "tasks/scheduler.ts": "the time trigger's own transaction: cancels the missed occurrence and inserts the next, each inside a mutate() as the task-scheduler system job (spine/systemJobs.ts)",
  "review/seam.ts": "a card's schedule copied within review_states (a note's row ↔ a block's) inside the block-move operation's event transaction (services/blockChildNote.ts); the move itself is the note's NODE_UPDATED",
  "tasks/pushReminders.ts": "push_reminder_sent / push_subscriptions: delivery bookkeeping of lock-screen reminders (migration 153), operational state with no domain event; the insert is the once-only claim",
  "tasks/blockTasks.ts": "block_nodes.task_id inside the note's save; the task itself goes through the spine (services allowlist below)",
  "tasks/placement.ts": "block_nodes.task_id released inside the unplace event transaction; the task, the note and the move all go through updateNode / moveToSpace (mutate)",
  // The fetch/retention worker writes ONLY boundary-buffer state: rss_staging
  // ingest + aging/tombstones, and outbox intents (its source's etag/last-fetched/
  // last-error columns are written through rss/sources.ts). External
  // stream state is not governed knowledge; the ONE node-creating write in
  // this module (save) lives in routes.ts and goes through mutate(). A
  // content_nodes/node_tags write appearing HERE would be a regression this
  // entry must not excuse — it documents the buffer, not a bypass.
  // Moved with the publish routes from routes/publish.ts.
  "website/routes.ts": "publish_snapshots is an external/system snapshot write",
  "rss/fetch.ts": "boundary-buffer writes only (rss_staging + outbox intents); the node-creating save is spine-routed in save.ts",
  "external_calendars/store.ts": "external_calendars / external_calendar_events: a person's own calendar subscriptions and their fetched instances (migration 160), personal settings with no domain event; each writer runs through mutatePersonal (the workspace event lock, the current actor, a write stamp, no event), and the address is only ever stored sealed",
  "rss/sources.ts": "rss_subscriptions: feed settings (migration 145), a setting not content, so no domain event; the callers (subscriptions.ts, sourceSpace.ts) hold the workspace event lock, re-read the current actor and check the space `edit` permission in the same transaction; the fetch loop's bookkeeping columns are event-free like node_positions",
  // Per-person progress (migration 092): a person's own review schedule and
  // settings overrides, read-gated, never a change to the shared note.
  // (routes.ts checks the note or tag first; the writes live in these files, D2.)
  "review/state.ts": "review_states: the caller's own review progress, not shared knowledge",
  "review/settings.ts": "actor_module_settings: the caller's own review settings, not shared knowledge",
  // Not matched by MUTATION_SQL (its UPDATE spans lines and aliases the table), listed for the record.
  "rss/staging.ts": "boundary-buffer writes only (rss_staging seen/saved/body, rss_seen); the node-creating save is spine-routed in routes.ts",
};
const MODULE_POOL_MUTATION_ALLOWLIST: Record<string, number> = {};

// A spine call: mutate() itself, or createNote() (services/noteCreate.ts),
// which runs its write and the caller's `within` rows inside mutate().
const SPINE_CALL = /\b(?:mutate|mutatePersonal|createNote)\(/;

describe("spine gate — routes mutate through mutate(), not raw event()", () => {
  const files = readdirSync(routesDir).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    it(`${file}: raw event() count is within the spine-gate allowlist`, () => {
      const src = readFileSync(join(routesDir, file), "utf8");
      // \bevent\(  matches the db event() primitive but not eventActorType(,
      // restoreEvent(, or the `domain_events` table.
      const rawEventCalls = (src.match(/\bevent\(/g) ?? []).length;
      const allowed = ROUTE_RAW_EVENT_ALLOWLIST[file] ?? 0;
      expect(rawEventCalls).toBe(allowed);
    });
  }
});

describe("spine gate — routes hold no mutation SQL (D2; eslint onden/no-route-writes)", () => {
  const files = readdirSync(routesDir).filter((f) => f.endsWith(".ts"));

  it("no route file runs INSERT/UPDATE/DELETE itself", () => {
    const writing = files.filter((file) => MUTATION_SQL.test(readFileSync(join(routesDir, file), "utf8")));
    expect(writing, "move the write into the service that owns the row and call it from the route").toEqual([]);
  });
});

// Precise: no NEW pool.query mutation (provable non-spine write) may appear.
describe("spine gate — pool.query mutations are frozen at the allowlist (provable bypasses)", () => {
  const files = readdirSync(routesDir).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    it(`${file}: pool.query mutation count is within the allowlist`, () => {
      const src = readFileSync(join(routesDir, file), "utf8");
      const count = (src.match(POOL_MUTATION) ?? []).length;
      const allowed = ROUTE_POOL_MUTATION_ALLOWLIST[file] ?? 0;
      expect(
        count,
        `${file}: found ${count} pool.query mutation(s), allowlist permits ${allowed}. ` +
          `A pool.query write can't join mutate()'s transaction — route it through the spine ` +
          `(q() inside a mutate() apply), or adjust the allowlist DOWN as you migrate.`,
      ).toBe(allowed);
    });
  }
});

// The same three gates over src/modules/*/ — module routes/services obey the
// identical rules as routes/ files (modules/README.md: "No bypassing the
// spine"). Both shipped modules (review, rss) pass with empty allowlists
// except rss/fetch.ts's documented boundary-buffer entry above.
describe("spine gate — modules/*/ mutate through mutate(), not raw event()", () => {
  for (const { key, path } of moduleSourceFiles()) {
    it(`modules/${key}: raw event() count is within the allowlist`, () => {
      const src = readFileSync(path, "utf8");
      const rawEventCalls = (src.match(/\bevent\(/g) ?? []).length;
      expect(rawEventCalls).toBe(MODULE_RAW_EVENT_ALLOWLIST[key] ?? 0);
    });

    it(`modules/${key}: writes go through mutate() (or are allowlisted)`, () => {
      const src = readFileSync(path, "utf8");
      if (!MUTATION_SQL.test(src)) return; // no writes → nothing to gate
      const usesMutate = SPINE_CALL.test(src);
      const allowed = key in MODULE_RAW_MUTATION_ALLOWLIST;
      expect(
        usesMutate || allowed,
        `modules/${key} runs INSERT/UPDATE/DELETE but never calls mutate() and isn't allowlisted`,
      ).toBe(true);
    });

    it(`modules/${key}: pool.query mutation count is within the allowlist`, () => {
      const src = readFileSync(path, "utf8");
      const count = (src.match(POOL_MUTATION) ?? []).length;
      expect(
        count,
        `modules/${key}: ${count} pool.query mutation(s) found — a pool.query write can't join ` +
          `mutate()'s transaction; route it through the spine (q() inside a mutate() apply).`,
      ).toBe(MODULE_POOL_MUTATION_ALLOWLIST[key] ?? 0);
    });
  }
});

// Net over the code the route writes moved into (D2). A SQL write in
// services/** or modules/** must sit lexically inside a call to the spine —
// mutate() (generic form too), withEventTransaction(), createNote() or
// runCascade() — or its FUNCTION is listed below with why its rows are written
// outside one. The unit is the function, not the file (the earlier net let a
// stray raw write pass once its file called the spine anywhere): a new helper in
// a file that already uses mutate() fails here until it is listed or moved.
// Most entries are row helpers their callers run INSIDE a mutate(); the rest
// are system bookkeeping that is not domain state. A helper that must never run
// bare also refuses at runtime (SERVICE_GUARDED_HELPERS). Drive the list down,
// never up. Shares the statement recogniser with eslint onden/no-route-writes.
const SERVICE_WRITE_HELPERS: Record<string, { why: string; functions: string[] }> = {
  "modules/index.ts": { why: "workspaces.modules backfill at boot (the registry's own column)", functions: ["backfillModuleImports"] },
  "services/freshProof.ts": { why: "fresh_proofs: a short-lived, single-use ticket that says the person proved it is them a moment ago (password, or a second explicit confirmation on the browser-only version); credential bookkeeping like rate_limit_hits, node-local, never workspace state, so no event", functions: ["consumeFreshProof", "grantFreshProof"] },
  "services/participantSessions.ts": { why: "participant_sessions: a temporary session's own limits, counted per request (the count, in the same UPDATE that refuses an ended or expired session) and per body the server has read (the bytes); credential bookkeeping like fresh_proofs, node-local, never replicated, no event", functions: ["chargeTemporarySessionBytes", "resolveTemporarySessionActor"] },
  "modules/review/seam.ts": { why: "review_states: the card's schedule copied when its text moves between a block and a child note, inside that operation's event transaction (the source rows stay, so undo finds them)", functions: ["copyProgress"] },
  "modules/review/settings.ts": { why: "actor_module_settings: the caller's own review settings, not shared knowledge", functions: ["clearPersonalSettings", "mergePersonalSettings", "replacePersonalSettings"] },
  "modules/review/state.ts": { why: "review_states: the caller's own review progress, written inside the grade's event transaction", functions: ["lockReviewState", "saveGradedState", "stepBackReviewState"] },
  "modules/tasks/pushReminders.ts": { why: "push_reminder_sent (the once-only claim of a reminder moment) and push_subscriptions (a gone device removed): delivery bookkeeping, not domain state, never synced or restored", functions: ["drainPushReminders", "sendDue"] },
  "modules/rss/fetch.ts": { why: "the feed staging buffer (ingest, aging, tombstones); the node-creating save is spine-routed", functions: ["performRssFetch", "sweepRssStaging"] },
  "modules/rss/sources.ts": { why: "rss_subscriptions: feed settings, not content (migration 145). Callers run them under the workspace event lock with the current actor and the space `edit` check (assertSourceWritable); no domain event, like a setting with no history to restore. recordFetch is the fetch loop's own bookkeeping (etag, last fetched, last error)", functions: ["createSource", "moveSources", "recordFetch", "removeSource", "writeSourceSettings"] },
  "modules/rss/staging.ts": { why: "rss_staging / rss_seen buffer rows (seen, saved, body); the node-creating save is spine-routed", functions: ["linkSavedNote", "markSeen", "replaceStagingBody"] },
  "services/actorPrefs.ts": { why: "actor_prefs: the caller's own preferences (the nav layout), not shared knowledge", functions: ["writePrefStamped"] },
  "services/pushSubscriptions.ts": { why: "push_subscriptions: the signed-in person's own devices for lock-screen reminders (migration 153), per-person settings with no domain event", functions: ["removeSubscription", "saveSubscription"] },
  "services/adminAccounts.ts": { why: "better-auth account.password and session rows, changed by the container admin CLI (no HTTP route, no signed-in actor); the audit event is written in the same transaction (docs/self-host/recovery.md)", functions: ["resetPassword", "revokeSessions"] },
  "services/actors.ts": { why: "actorForSession: the session actor's seat row, inside its own mutate()s' transaction (see the function's note on the idempotency middleware)", functions: ["actorForSession"] },
  "services/agentRuntime/api/actor.ts": { why: "the api session's own session token (agent_tokens), minted and revoked with that session; the session's STARTED/ENDED events are the record", functions: ["actorForRuntimeSession"] },
  "services/agentRuntime/api/deliver.ts": { why: "the api session's final reply text on its own row; the note is never written (suggestions go through createSuggestions' mutate)", functions: ["deliverApiResult"] },
  "services/agentRuntime/api/models.ts": { why: "marks the role's chosen model retired: a pause of the api runtime, no domain event (the owner sees it on the role)", functions: ["markModelRetired"] },
  "services/agentRuntime/api/usage.ts": { why: "diagnostic log lines and token totals of an api session (agent_session_events / agent_sessions); not domain events, never synced or restored", functions: ["logLine", "recordUsage"] },
  "services/agentRuntime/api/run.ts": { why: "the one-shot claim queued → running of an api session (a guarded UPDATE; the session's STARTED/ENDED events are the record)", functions: ["startApiRun"] },
  "services/agentSessions.ts": { why: "agent_sessions bookkeeping (status, seq, delivery claims) written in the same transaction as the session's own event; the session's STARTED/ENDED events are the record", functions: ["appendEvent", "approveIfReplyOnly", "claimSession", "createSession", "markDelivered"] },
  "services/aiRoles.ts": { why: "runner_seen_at: a client's last poll for queued sessions, a liveness fact folded into the mcp runtime's last seen; diagnostic bookkeeping like the session log, no event", functions: ["touchRunnerSeen"] },
  "services/panelChat.ts": { why: "「清除這段對話」: hides the person's own panel_chat sessions from the panel and the model (chat_cleared_at); the sessions stay for cost and history. Display bookkeeping like the session log, no event, never synced or restored", functions: ["clearPanelChat"] },
  "services/agentSessionStore.ts": { why: "the skill the AI chose for itself (loadSkill) kept on its own session row for the suggestion card; bookkeeping like the session log, no event (here, not in agentSessions.ts, so agentTools does not import the session starter back)", functions: ["recordPickedSkill"] },
  "services/agentTokens.ts": { why: "token rows, written inside services/actors.ts's principal_admin mutate()s (TOKEN_* events)", functions: ["createToken", "resolveBearerActor", "revokeToken", "revokeTokensIssuedBy", "setTokenAccess"] },
  "services/agentTools/rateLimit.ts": { why: "rate_limit_hits: the shared limiter's sliding window", functions: ["check", "reset"] },
  "services/aiSuggestions.ts": { why: "ai_edit_suggestion_items status: settle() is called only inside the accept/reject mutate() (the AI_SUGGESTION_ACCEPTED/REJECTED event is the record) or for void items, which are no event by design (nothing was decided or written)", functions: ["settle"] },
  "services/attributeChange.ts": { why: "retypeGoverned: derived value_type of governed fields, re-run by every write that changes governance (test/retypeWriters.test.ts holds the callers)", functions: ["retypeGoverned"] },
  "services/backupRestore.ts": { why: "stampTimes: a restored note keeps its backup timestamps, written inside BACKUP_RESTORED's runCascade", functions: ["stampTimes"] },
  "services/backupRestoreJobs.ts": { why: "backup_restore_jobs: a restore job's status and progress; the restore's notes are written by services/backupRestore.ts inside BACKUP_RESTORED's runCascade", functions: ["failInterruptedRestoreJobs", "progress", "runJob", "startRestoreJob"] },
  "services/blobs.ts": { why: "the content-addressed blob store (events → hash → blobs); idempotent by hash", functions: ["putBlob"] },
  "services/blockAnchors/store.ts": { why: "block_anchors: where a paragraph is, moved inside the transaction that wrote the body (applyBodyChange) so text and positions commit together; creation (insertAnchor, via ensureBlockAnchor / linkBlockNodeAnchors) runs in its caller's transaction. Anchor events (create / confirm / lose) come with the batch that shows anchors (proposal §2.3)", functions: ["insertAnchor", "confirmAnchorCandidate", "moveAnchorsForBodyChange", "restoreBackupAnchors"] },
  "services/blockLinks.ts": { why: "block_link_bindings: which anchor a [[筆記/段落]] link means. Written by createBlockLink inside withEventTransaction (with the anchor and the BLOCK_ANCHOR_LINKED record); a backup restore puts a note's bindings back after the notes exist, like the anchors", functions: ["restoreBackupBindings"] },
  "services/blockNodes.ts": { why: "block_nodes / block_node_tags: derived from a note's {…} block tags, rebuilt inside the save that changed the text (docs/architecture/block-nodes.md)", functions: ["resolveTagNames", "setTags", "syncBlockNodes"] },
  "modules/tasks/blockTasks.ts": { why: "block_nodes.task_id: links a task line to its task node inside the note's save; the task itself is created, updated and trashed through the spine (createTaskNode, updateTask, trashNode) — block-nodes.md B4", functions: ["syncBlockTasks"] },
  "services/boardStore.ts": { why: "board layout rows (positions, sections). writeSections and clearSurface run inside the board's own CANVAS/BOARD_UPDATED mutate(); setNodePosition is also called by PUT /api/nodes/:id/position, which deliberately records no event (a drag is not history, routes/nodes.ts)", functions: ["clearSurface", "setNodePosition", "writeSections"] },
  "services/dispatcherQueue.ts": { why: "dispatcher_pending: the post-commit work queue (a delivery intent, not domain state), enqueued with the event that caused it", functions: ["enqueueCascadeIntent", "queueDispatcher"] },
  "services/embeddings.ts": { why: "node_embeddings and semantic edges: a derived search index, recomputed from committed text (the suggested-link rewrite, writeSuggestedLinks, refuses outside a transaction: db.ts requireTransaction)", functions: ["embedNode", "writeSuggestedLinks"] },
  "services/eventRestore/attributes.ts": { why: "an undo writes the exact earlier attribute row inside restoreEvent's event transaction", functions: ["restoreAttribute"] },
  "services/functionRefs.ts": { why: "function_refs rows: insertFunctionRefs inside the tag-pack import (tagPacks.ts), each in the caller's mutate() that records the event; touchTag bumps the tag row inside addFunction/removeFunction/setFunctionConfig's mutate(); restoreFunctionRef runs inside restoreEvent's event transaction; the other writers (addFunction, removeFunction, setFunctionConfig) call mutate() themselves", functions: ["insertFunctionRefs", "restoreFunctionRef", "touchTag"] },
  "services/eventReview.ts": { why: "recordReview: the one writer of event_reviews, in the review decision's transaction", functions: ["recordReview"] },
  "modules/importers/shared/identity.ts": { why: "the import stamp (_import_*), a derived index written inside the import's createNote/updateNode", functions: ["stamp", "stampImportedNote"] },
  "services/maintenance/prune.ts": { why: "the operator's orphan-blob sweep: blobs (and chunk-stored drawings) no event references, past the put grace", functions: ["collectOrphanBlobs"] },
  "services/media.ts": { why: "storeMedia: the uploaded file's row, claimed by the saving note afterwards (mediaOwners.ts); storeGeneratedMedia: a published handwriting page's file and its upload row, written with the publish that records the snapshot's PUBLISH_SNAPSHOT_CREATED; removeMediaFiles: the one removal of an upload's record, inside the purge's NODES_PURGED or the publish that replaces a handwriting page", functions: ["removeMediaFiles", "storeGeneratedMedia", "storeMedia"] },
  "services/mediaOwners.ts": { why: "which note owns an uploaded file, claimed inside the saving note's mutate()", functions: ["claimUploadedMedia"] },
  "services/memberRemovals.ts": { why: "member_removals rows, written inside services/actors.ts's ACTOR_* mutate()s", functions: ["liftMemberRemoval", "recordMemberRemoval"] },
  "services/nodeUpdate.ts": { why: "applyNodeColumns: the note's row, written inside a save's mutate() (updateNode) or an undo's (restoreNodeUpdated in restoreEvent's event transaction)", functions: ["applyNodeColumns"] },
  "services/tagIdentity.ts": { why: "applyTagIdentity: a tag's name, slug and color, written inside writeTagIdentity's mutate() or the undo of a TAG_UPDATED (restoreTagUpdate in restoreEvent's event transaction)", functions: ["applyTagIdentity"] },
  "services/nodeTrash.ts": { why: "markTrashed / markLive: the trash flag, called inside nodeTrash's own mutate()s and event restore", functions: ["markLive", "markTrashed"] },
  "services/noteBlockRefs.ts": { why: "syncNoteBlockRefs: the `^id` index follows the note body, inside the body write's transaction (bodySideEffects.applyBodyChange, newNoteDerived.finishNewNote)", functions: ["syncNoteBlockRefs"] },
  "services/orderKeys.ts": { why: "respaceSiblings: fresh keys for one sibling group, called by a write inside its own mutate() transaction (one stamp); a read never respaces", functions: ["respaceSiblings"] },
  "services/noteDuplicate.ts": { why: "recordCopiedTag: a copied relation with its TAG_APPLIED lineage, inside the duplicate's mutate()", functions: ["recordCopiedTag"] },
  "services/outbox.ts": { why: "the transactional outbox: effects enqueued inside their event's transaction, then settled by the reconciler", functions: ["approveHeldEffect", "dismissDeadEffects", "enqueueEffect", "reapOutbox", "rejectHeldEffect", "requeueDeadEffect", "runDrain", "watchAbandoned"] },
  "modules/website/publishing/snapshot.ts": { why: "publish_snapshots: the publish pipeline's system snapshot, written inside the publish operation", functions: ["buildAndEnqueueSnapshot"] },
  "modules/website/publishing/takenDown.ts": { why: "recordTakedowns: the snapshot's list of notes taken off the site, written inside the transaction of the change that took them off (requestSiteRebuild, called from the website module's node hooks)", functions: ["recordTakedowns"] },
  "services/purgedContent.ts": { why: "erasing a purged note's events, blobs, files, queued work and published copies, inside nodeTrash.ts purgeDeleted's NODES_PURGED mutate()", functions: ["deleteUnreferencedBlobs", "dropQueuedWorkAbout", "eraseEventsAbout", "forgetNodesInSnapshots", "forgetUnreferencedMedia"] },
  "services/siteConfig.ts": { why: "the hidden Site Config row in the system space: ensureConfigNodeId creates it inside nested TAG_CREATED / NODE_CREATED mutate()s; patchSiteConfig / setChromeBlocks run inside SITE_CONFIG_UPDATED's mutate() (refuse outside a transaction: db.ts requireTransaction)", functions: ["patchSiteConfig", "setChromeBlocks"] },
  "services/snapshotMedia.ts": { why: "the media index of a publish snapshot, written in the transaction that writes the snapshot (its own table, no event)", functions: ["recordSnapshotMedia"] },
  "services/spaces.ts": { why: "relinkAfterMove: derived wikilink edges, rebuilt inside the move's mutate()", functions: ["relinkAfterMove"] },
  "services/tagMembership.ts": { why: "node_tags + node_tag_states, written by tagMembershipWrites inside the TAG_APPLIED/REMOVED mutate()", functions: ["restoreTagMembership"] },
  "services/tagMembershipWrites.ts": { why: "attachTagInTx: the tag link row, inside the TAG_APPLIED mutate()", functions: ["attachTagInTx"] },
  "services/tagWrites.ts": { why: "insertTagRow / writeTagSchema: the tag definition row (and ensureModuleSelfRef: a module tag's own function reference, written with it), inside the caller's principal_admin mutate() (or event restore)", functions: ["ensureModuleSelfRef", "insertTagRow", "writeTagSchema"] },
  "services/tasksStore.ts": { why: "task node rows (node, #task link, _task_* attributes), inside the caller's mutate() or the scheduler's per-task event transaction", functions: ["insertTaskNodeTx", "setTaskAttrTx", "setTaskTitleTx"] },
  "services/wikilinkEdges.ts": { why: "wikilink edges derived from note text (both directions), rebuilt inside the write that changed the text, title, aliases, space or trash state; plus the note's link index (note_link_index), a derived lookup written beside them (and filled at start-up)", functions: ["<module>", "indexMissingNoteLinks", "indexNoteLinks", "relinkTarget", "syncWikilinkEdges"] },
};

/** A call into the spine: mutate( / mutate<T>( (generics may nest),
 *  mutatePersonal(, mutateRestore(, withEventTransaction(, createNote(. */
const SPINE_ENTRY = /\b(?:mutate|mutatePersonal|mutateRestore|withEventTransaction)\s*(?:<[\s\S]{0,200}?>)?\s*\(|\bcreateNote\s*\(/;

// A helper that relies on its caller's transaction says so at runtime: it calls
// db.ts requireTransaction(), so a bare call fails instead of committing the
// row with no event and no lock. file#function -> the call must be in its body.
const SERVICE_GUARDED_HELPERS = [
  "services/boardStore.ts#writeSections", "services/boardStore.ts#clearSurface",
  "services/embeddings.ts#writeSuggestedLinks",
  "services/siteConfig.ts#patchSiteConfig", "services/siteConfig.ts#setChromeBlocks",
  "services/tagWrites.ts#insertTagRow", "services/wikilinkEdges.ts#syncWikilinkEdges",
  "services/wikilinkEdges.ts#relinkTarget",
];

// pool.query cannot join mutate()'s transaction, so a write through it is never
// atomic with an event. Count per file, frozen at the bookkeeping tables below
// (the outbox, queues, rate limiter, blob store, token and embedding rows),
// none of which holds notes, attributes or tags. Drive it down, never up.
const SERVICE_POOL_WRITE_ALLOWLIST: Record<string, number> = {
  "services/agentTokens.ts": 1,
  "services/agentTools/rateLimit.ts": 1,
  "services/blobs.ts": 1,
  "services/dispatcherQueue.ts": 1,
  "services/embeddings.ts": 1,
  "services/maintenance/prune.ts": 1,
  "services/outbox.ts": 7,
};

describe("spine gate — services/modules that write SQL reach the spine (or their function is listed)", () => {
  const srcRoot = join(routesDir, "..");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []);
  const files = [...walk(join(srcRoot, "services")), ...walk(join(srcRoot, "modules"))]
    .map((path) => ({ rel: relative(srcRoot, path).split(sep).join("/"), source: readFileSync(path, "utf8") }));
  const writes = files.flatMap(({ rel, source }) => sqlWritesIn(rel, source).map((w) => ({ ...w, rel })));

  it("every write outside a spine call is in a listed function", () => {
    const outside = new Map<string, Set<string>>();
    for (const w of writes) if (!w.inSpineCall) outside.set(w.rel, (outside.get(w.rel) ?? new Set()).add(w.fn));
    const found = Object.fromEntries([...outside].sort().map(([file, fns]) => [file, [...fns].sort()]));
    const listed = Object.fromEntries(Object.entries(SERVICE_WRITE_HELPERS).sort()
      .map(([file, { functions }]) => [file, [...functions].sort()]));
    expect(found, "route the write through mutate()/withEventTransaction(), or list its function with why (and drop entries whose function is gone)").toEqual(listed);
  });

  it("pool.query writes stay at the bookkeeping allowlist", () => {
    const count: Record<string, number> = {};
    for (const w of writes) if (w.viaPool && w.rel.startsWith("services/")) count[w.rel] = (count[w.rel] ?? 0) + 1;
    expect(count, "a pool.query write can't join mutate()'s transaction: use q() inside a mutate() apply").toEqual(SERVICE_POOL_WRITE_ALLOWLIST);
  });

  it("helpers that rely on their caller's transaction refuse to run outside one", () => {
    for (const entry of SERVICE_GUARDED_HELPERS) {
      const [file, fn] = entry.split("#") as [string, string];
      const source = files.find((f) => f.rel === file)?.source ?? "";
      expect(source, `${entry} must call requireTransaction("${fn}")`).toContain(`requireTransaction("${fn}")`);
      expect(SERVICE_WRITE_HELPERS[file]?.functions, `${entry} is a listed helper`).toContain(fn);
    }
  });

  it("sees a stray write beside a spine call, a bare one, and a pool one", () => {
    const sample = `
      export async function covered() { return mutate<Record<string, unknown>>({ apply: async () => { await q("UPDATE a SET b = 1"); } }); }
      export async function helper() { await q("DELETE FROM t WHERE id = $1", [1]); }
      export async function sneaky() { await pool.query(\`INSERT INTO t (a) VALUES ($1)\`, [1]); }
      export async function readOnly() { await q("SELECT 1"); }`;
    const found = sqlWritesIn("services/x.ts", sample).map((w) => [w.fn, w.inSpineCall, w.viaPool]);
    expect(found).toEqual([["covered", true, false], ["helper", false, false], ["sneaky", false, true]]);
  });
});

// Permission-DEFINING operations (mint/revoke tokens, create/modify actors, edit
// a tag definition) must be reserved to the workspace owner — the
// `principal_admin` authority, which a delegated bearer token can never satisfy.
// This freezes the known set so a regression that swaps one back to a plain
// role/workspace_admin gate (which an admin-role agent token WOULD satisfy)
// fails the build. The "human is prioritized over the agent" invariant, by
// construction.
// Paths relative to src/. A tag definition's routes and the services they
// moved into (W7) count together.
const PRINCIPAL_ADMIN_DECLARATIONS: Record<string, { files: string[]; count: number }> = {
  // create / patch / delete actor + regenerate an invite link + mint / re-scope / revoke / delete token (TOKEN_RESCOPED is permission-defining → principal-only)
  "actors": { files: ["services/actors.ts"], count: 8 },
  // A tag definition is global and the owner's. routes/tags.ts: schema PATCH
  // (route check; the in-lock check is tagWrites.patchTagSchema's, D100);
  // services/tagPacks.ts: the pack import (check + mutate, installTagPack —
  // moved from routes/tags.ts, D13); services/tagIdentity.ts: tag PATCH
  // (check + mutate); services/tagViews.ts: saved view create / update /
  // delete; services/tagMerge.ts: merge (check + mutate).
  "tags": { files: ["routes/tags.ts", "services/tagViews.ts", "services/tagMerge.ts", "services/tagIdentity.ts", "services/tagPacks.ts"], count: 10 },
  // changeTagSchema: every recorded schema change (tag PATCH, tag functions,
  // extends, module import) mutates as the owner; patchTagSchema (the schema
  // PATCH and the Collections manager, D100) checks the current actor under the lock.
  "tag schema": { files: ["services/tagWrites.ts"], count: 2 },
};

describe("principal gate — permission-defining ops are owner-only (principal_admin)", () => {
  const srcDir = join(routesDir, "..");
  for (const [group, { files, count: expected }] of Object.entries(PRINCIPAL_ADMIN_DECLARATIONS)) {
    it(`${group}: declares principal_admin authority ${expected}x`, () => {
      const count = files.reduce((sum, file) =>
        sum + (readFileSync(join(srcDir, file), "utf8").match(/kind:\s*"principal_admin"/g) ?? []).length, 0);
      expect(
        count,
        `${files.join(", ")}: found ${count} principal_admin authorities, expected ${expected}. ` +
          `Permission-defining mutations must declare { kind: "principal_admin" } so a ` +
          `delegated token (even admin-role) cannot redefine permissions — never downgrade ` +
          `these to "role"/"workspace_admin".`,
      ).toBe(expected);
    });
  }
});
