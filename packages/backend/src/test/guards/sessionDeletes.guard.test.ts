// Every unit of src/ (a named function, a route handler written in place, an outbox effect's perform) that deletes a row (`DELETE FROM`, Kysely `deleteFrom(`) or names a `*_DELETED` event that the restore
// contract cannot undo says how a temporary session is kept from it (PR #1856 review round 4, point 4b; the rule: a session may add, move and rename,
// never take away what nothing brings back). A function passes when its own body:
//   1. names an authority a session never holds: `irreversible` (assertUndoableBy refuses a session), `own_personal` (refused to a session),
//      `system` (a background job's actor only), `principal_admin` / `review` (the workspace owner: a session's actor is never workspaces.owner_actor_id:
//      ownerTransfer.ts hands it only to type 'human', and migration 217 keeps a session's row a session's), `need: "manage"` on a space (the owner of a personal space is a person; a shared space is managed
//      by the workspace owner), or calls requirePerson / assertUndoableBy / mutatePersonal itself; or
//   2. writes a `*_DELETED` event the restore contract undoes (restoreContract.ts restoreBlockedReason: null), so the removal has an inverse; or
//   3. is listed below with why a session never gets there (a helper called from a guarded caller, a background job, a cache).
// Units: the outermost named function, a route handler written in place, an outbox effect's `perform:`; all of src/ (round 5). The guard must
// come before the first delete in the unit's text. Limits: a helper's delete is judged by the reason its line gives for its callers (read, not
// proven); a delete written through a variable table name, or in a file outside src/ (scripts, migrations), is not seen (migration 217 keeps a
// session's own actors row in the database itself).
// Judged per function by name (`<file>#<name>`), from the text of its body: a new delete in an unlisted, unguarded function turns this red.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { restoreBlockedReason } from "../../services/restoreContract.js";
import "../../services/eventRestore/restore.js";

const SRC = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" || e.name === "browser" ? [] : sourceFiles(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") ? [path] : [];
  });
}

const SESSION_UNREACHABLE = /kind:\s*"(irreversible|own_personal|system|principal_admin|review)"|need:\s*"manage"|\b(requirePerson|assertUndoableBy|mutatePersonal)\(/;
const DELETES = /\bDELETE\s+FROM\b|\.deleteFrom\(/;
const DELETED_EVENT = /\btype:\s*"([A-Z_]+_DELETED)"/g; // an event the function writes (`type: "X_DELETED"`), not one a reader names

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "on", "use"]);

/** The units judged: the outermost named function, route handler written in place (`router.post("/x", async (c) => …)`), or `perform:` of an
 *  outbox effect. The guard must come BEFORE the first delete in the unit's text (round 5): a refusal after the delete refuses nothing. */
function analyse(files: Array<{ file: string; text: string }>) {
  const found: Array<{ key: string; why: "guarded" | "restorable" | null }> = [];
  for (const { file, text } of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const judge = (key: string, node: ts.Node) => {
      const body = node.getText(source);
      const events = [...body.matchAll(DELETED_EVENT)].map((m) => m[1]!);
      const lost = events.filter((type) => restoreBlockedReason({ event_type: type }) !== null);
      const deleteAt = body.search(DELETES);
      const lostAt = lost.length > 0 ? body.search(new RegExp(`"${lost[0]}"`)) : -1;
      if (deleteAt < 0 && lost.length === 0) return;
      const first = Math.min(...[deleteAt, lostAt].filter((x) => x >= 0));
      const guardAt = body.search(SESSION_UNREACHABLE);
      const why = guardAt >= 0 && guardAt < first ? "guarded" : lost.length === 0 && events.length > 0 ? "restorable" : null;
      found.push({ key: `${relative(SRC, file)}#${key}`, why });
    };
    const visit = (n: ts.Node) => {
      let own: string | null = null;
      if (ts.isFunctionDeclaration(n) && n.name && n.body) own = n.name.text;
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) own = n.name.text;
      else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.body) own = n.name.text;
      else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "perform" && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
        const holder = n.parent;
        const kind = ts.isObjectLiteralExpression(holder) ? holder.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "kind") : undefined;
        own = `perform:${kind && ts.isPropertyAssignment(kind) ? kind.initializer.getText(source) : "?"}`;
      }
      if (own) { judge(own, n); return; } // the outermost unit owns its nested ones
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ROUTE_METHODS.has(n.expression.name.text)) {
        const pathAt = n.expression.name.text === "on" ? 1 : 0;
        const path = n.arguments[pathAt];
        const label = path && (ts.isStringLiteral(path) || ts.isTemplateExpression(path)) ? path.getText(source).replace(/^["'`]|["'`]$/g, "") : null;
        if (label && label.startsWith("/") || label?.startsWith("${")) {
          for (const arg of n.arguments.slice(pathAt + 1)) {
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) judge(`${n.expression.name.text.toUpperCase()} ${label}`, arg);
            else visit(arg);
          }
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  return found;
}

/** Functions that delete and do not name a session-unreachable authority themselves: each says why a temporary session never takes away, through
 *  it, what nothing brings back. Only shrinks. */
// ratchet:list session-deletes-unguarded
const LISTED: Record<string, string> = {
  // a person's own rows, written under mutatePersonal (own_personal: refused to a session) by the caller named
  "services/actorPrefs.ts#writePrefStamped": "a preference row; its one caller runs it inside mutatePersonal",
  "modules/review/settings.ts#mergePersonalSettings": "review settings; service.ts patchSettings runs it inside mutatePersonal",
  "modules/review/settings.ts#clearPersonalSettings": "review settings; service.ts clearSettings runs it inside mutatePersonal",
  "modules/review/state.ts#stepBackReviewState": "review progress; service.ts runs the step back inside mutatePersonal",
  "modules/rss/staging.ts#markSeen": "seen marks of the caller's own id: routes.ts runs it inside mutatePersonal; save.ts (saving an article as a note) only marks it seen (adds, takes nothing away)",
  "modules/rss/sources.ts#removeSource": "a feed; subscriptions.ts unsubscribe runs it inside changeSource, which refuses a session (own_personal)",
  "services/pushSubscriptions.ts#removeSubscription": "only rows whose actor_id is the caller's own: a session takes away nothing but what it added itself",
  // a person or the owner only, asked by the caller named
  "services/freshProof.ts#grantFreshProof": "drops expired tickets; only issueFreshProof calls it, after requirePerson(actor, \"fresh_proof\")",
  "services/backupLinks.ts#settleWikilinkEdges": "a backup restore's link pass; backupRestore.ts requires a person (requirePerson \"backup\")",
  "services/siteConfig.ts#patchSiteConfig": "site settings; workspaceSettings.ts runs it under principal_admin",
  "services/memberRemovals.ts#liftMemberRemoval": "actors.ts runs it under principal_admin, or on a login claiming the owner's invite (a session never logs in)",
  "services/participantSessions.ts#endTemporarySessionsOpenedBy": "ends a removed member's sessions; actors.ts runs it under principal_admin",
  "services/functionRefs.ts#removeView": "deleting a view: noteViews.ts and tagViews.ts run it under irreversible",
  "services/boardStore.ts#writeSections": "a board's sections; applyBoardChanges refuses a removal to a session (irreversible), and a merge that keeps them has nothing to take away",
  "services/boardStore.ts#clearSurface": "no product caller (tests only)",
  // the removal has an inverse: the caller writes an event the restore contract undoes
  "services/attributeChange.ts#storeAttributeState": "the one attribute row writer; its removal is recorded as ATTRIBUTE_DELETED (restorable), and the publish mark is refused to a session here",
  "services/tasksStore.ts#setTaskAttrTx": "a task's `_task_*` field; the caller records each change as ATTRIBUTE_SET / ATTRIBUTE_DELETED on the reserved key (modules/tasks/update.ts), which restore undoes",
  "services/tagMembershipWrites.ts#changeMembership": "taking a tag off; TAG_REMOVED is undone by tagMembership.ts's restore handler",
  "services/functionRefs.ts#deleteOwnRef": "a note stops being a review card; FUNCTION_REF_REMOVED is undone by functionRefs.ts's restore handler",
  "services/functionRefs.ts#restoreFunctionRef": "the restore handler itself: undoing an add, written as a new, restorable event",
  "services/tagMembership.ts#restoreTagMembership": "the restore handler itself: undoing an apply, written as a new, restorable event",
  // derived from a note's text or links: undone with the save that caused it (restoreEvent's cascade)
  "services/blockNodes.ts#setTags": "a block's tags, read from its text",
  "services/functionRefs.ts#deleteOwnRefViaWord": "a card mark read from the text (`#review`): the word was removed by a save",
  "services/noteBlockRefs.ts#syncNoteBlockRefs": "block references read from the text",
  "services/wikilinkEdges.ts#syncWikilinkEdges": "link edges read from the text",
  "services/wikilinkEdges.ts#relinkTarget": "link edges re-resolved after a rename or move",
  "services/spaces.ts#relinkAfterMove": "link edges re-resolved after a space move",
  "services/embeddings.ts#writeSuggestedLinks": "suggested links, recomputed from embeddings",
  "modules/importers/shared/identity.ts#stampImportedNote": "an import's own bookkeeping attributes (`_import_*`, the kept-off stamp)",
  // background jobs, caches and the server's own bookkeeping (no request of a session runs them)
  "services/dispatcherQueue.ts#queueDispatcher": "the dispatcher's own pending intent, settled after the event committed",
  "services/dispatcherQueue.ts#replayIntent": "the dispatcher's own pending intent, settled on replay",
  "services/outbox.ts#reapOutbox": "delivered outbox rows",
  "services/backupRestoreJobs.ts#failInterruptedRestoreJobs": "at server start: restore jobs a restart cut off",
  "services/maintenance/prune.ts#collectOrphanBlobs": "maintenance: files no row points at",
  "services/media.ts#removeMediaFiles": "called by a purge (irreversible) and by a website publish, in the publish's transaction (principal_admin: the owner's), for the page images the new publish replaced",
  "services/purgedContent.ts#dropQueuedWorkAbout": "work queued about a note purged for good (the purge is irreversible)",
  "services/purgedContent.ts#deleteUnreferencedBlobs": "files of a note purged for good (the purge is irreversible)",
  "services/snapshotMedia.ts#recordSnapshotMedia": "the website build's record of a snapshot's files (a background job)",
  "modules/external_calendars/store.ts#saveFetchResult": "the cache of a calendar fetch (assertMayReachOut: a session never fetches)",
  "modules/tasks/pushReminders.ts#drainPushReminders": "the reminder job's sent reminders",
  "modules/tasks/pushReminders.ts#sendDue": "the reminder job's sent reminders",
  "services/agentTools/rateLimit.ts#check": "an AI token's rate-limit window",
  "services/agentTools/rateLimit.ts#reset": "an AI token's rate-limit window (tests and the token's removal)",
  "services/adminAccounts.ts#resetPassword": "the container admin command (admin.ts): no HTTP route",
  "services/adminAccounts.ts#revokeSessions": "the container admin command (admin.ts): no HTTP route",
  // outside services/ and modules/ (round 5: the scan covers all of src/)
  "db.ts#discardUnfinishedJoins": "at server start: the rows of a node join a restart cut off (no request runs it)",
  "db.ts#pruneEvents": "the event retention job (a timer, no request)",
  "server.ts#pruneIdempotencyKeys": "the timer that drops expired idempotency keys",
  "spine/stampedImport.ts#beginJoin": "joining this node to another: only importSnapshotStream, which asks requireSnapshotOwner (the workspace owner) first",
  "spine/stampedImport.ts#clearWhatInsertTriggersMade": "the same join",
  "spine/stampedMerge/dbRows.ts#storeTable": "taking a change bundle from another node (applyChangeBundle): no product route calls it yet; when one does, the sender is a node, not a request. Every removal of a merge is here (the rows that go with their note, a row that lost its natural key)",
  "spine/stampedMerge/dbUnits.ts#storeUnit": "the same, and the snapshot join (the owner's)",
};

describe("deletes: a temporary session never takes away what nothing brings back (services/, modules/)", () => {
  const files = sourceFiles(SRC).map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const found = analyse(files);

  it("finds the deletes (control: the purge and a view's deletion are among them, guarded)", () => {
    expect(found.filter((f) => f.why === "guarded").length).toBeGreaterThan(5);
    expect(found.map((f) => f.key)).toContain("services/functionRefs.ts#removeView");
  });

  it("each declares a session-unreachable authority, writes a restorable *_DELETED event, or is listed with why", () => {
    const unlisted = found.filter((f) => f.why === null).map((f) => f.key).sort();
    expect(unlisted, "a function deletes without a session-unreachable authority: wrap its mutate in irreversible (or the right kind), or list it with why")
      .toEqual(Object.keys(LISTED).sort());
  });

  it("self-test: a bare delete is found; irreversible, own_personal or a restorable event clears it; an unrestorable event alone does not", () => {
    const file = join(SRC, "services", "fixture.ts");
    const one = (text: string) => analyse([{ file, text }]);
    expect(one("async function drop() { await q(`DELETE FROM things`); }")).toEqual([{ key: "services/fixture.ts#drop", why: null }]);
    expect(one("async function drop() { await mutate({ authority: { kind: \"irreversible\", of: x }, apply: () => q(`DELETE FROM things`) }); }")[0]!.why).toBe("guarded");
    expect(one("const drop = async () => mutate({ authority: { kind: \"own_personal\" }, apply: () => db.deleteFrom(\"t\").execute() });")[0]!.why).toBe("guarded");
    expect(one("async function drop() { await mutate({ event: { type: \"NODE_DELETED\" }, apply: () => q(`DELETE FROM x`) }); }")[0]!.why).toBe("restorable");
    expect(one("async function drop() { await mutate({ event: { type: \"SPACE_DELETED\" } }); }")[0]!.why).toBe(null);
    expect(one("function read() { if (type === \"TASK_DELETED\") return 1; }")).toEqual([]);
    // the guard after the delete does not count; a route handler in place and an effect's perform are units of their own
    expect(one("async function drop(a) { await q(`DELETE FROM t`); assertUndoableBy(a); }")[0]!.why).toBe(null);
    expect(one("router.delete(\"/x\", async (c) => { await q(`DELETE FROM t`); });")).toEqual([{ key: "services/fixture.ts#DELETE /x", why: null }]);
    expect(one("const e = { kind: \"k\", perform: async () => { await q(`DELETE FROM t`); } };")).toEqual([{ key: "services/fixture.ts#perform:\"k\"", why: null }]);
  });
});
