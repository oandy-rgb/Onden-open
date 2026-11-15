import type { Op } from "./ops.js";

type Case = {
  ops: Op[];
  /** The product does not handle this yet: the case runs as `it.fails`, so the suite stays green
   *  until someone fixes it (then it goes red until this flag is removed). */
  knownFailure?: boolean;
  /** Also demand that a retry of an applied write is answered as a success (invariants.Checks). */
  strictRetry?: boolean;
  /** Members run: let network faults hit the membership check too (off by default, see SimClient.membershipFaults). */
  membershipFaults?: boolean;
  /** Also demand that one repeating task never leaves two next occurrences (invariants.Checks). */
  strictOccurrences?: boolean;
  /** Also demand that an undo right after an undo steps back nothing (invariants.Checks). */
  strictUndo?: boolean;
  /** Also demand that one showing of a card counts one review (invariants.Checks). */
  strictGradeOnce?: boolean;
  note: string;
};

/** Shrunk op sequences that once broke an invariant, named for what they show. */
// The sync-delta bug the simulator found (a late DISPATCHER_FAILED event kept a deleted note on the
// devices) is fixed in services/sync/delta.ts and pinned deterministically in
// syncDelta.integration.test.ts: its trigger is a background race, not an op sequence.
export const REGRESSIONS: Record<string, Case> = {
  // Retry after a lost reply: the server applied the write, the reply is lost, the device retries with the
  // SAME Idempotency-Key. It must get the acknowledgement (app.ts replay shield), not a 404/409 refusal.
  "retrying a delete whose reply was lost is acknowledged, not refused (404)": {
    strictRetry: true,
    note: "Device A deletes a note, the reply is lost; on reconnect its retry with the same key gets 404.",
    ops: [{ kind: "delete", client: 0, note: 1, fate: "lose_response" }],
  },
  "retrying an undelete whose reply was lost is acknowledged, not refused (409)": {
    strictRetry: true,
    note: "Device A deletes a note and restores it, the restore's reply is lost; the retry gets 409 (already live).",
    ops: [
      { kind: "delete", client: 0, note: 1, fate: "deliver" },
      { kind: "undelete", client: 0, pick: 0, fate: "lose_response" },
    ],
  },
  "retrying a saved edit after the note was deleted elsewhere is acknowledged, not refused (404)": {
    strictRetry: true,
    note: "Device B saves an edit, the reply is lost; device A deletes the note; B's retry with the same key gets 404.",
    ops: [
      { kind: "edit", client: 1, note: 1, how: "insert", at: 0, fate: "lose_response" },
      { kind: "delete", client: 0, note: 1, fate: "deliver" },
    ],
  },

  // PINNED SCENARIOS (not failures): the property rules the server documents, as fixed sequences.
  "a property edited offline long ago still lands (last writer wins) and the overwrite is recorded": {
    note: "Device B sets a property; device A, offline, had edited it earlier; on reconnect A's stale edit replaces B's value and an ATTRIBUTE_CONFLICT is recorded.",
    ops: [
      { kind: "setAttr", client: 1, note: 1, key: 0, fate: "deliver" },
      { kind: "offline", client: 0 },
      { kind: "setAttr", client: 0, note: 1, key: 0, fate: "deliver" },
      { kind: "online", client: 0, fates: [] },
    ],
  },

  "two devices dragging the same note: the later request wins and both devices show it after the refresh": {
    note: "Device A drags a note, device B drags it elsewhere (reply lost, retried): the server keeps the later position; positions travel by the meta refresh, not the sync delta.",
    ops: [
      { kind: "place", client: 0, note: 1, x: 5, y: 7, fate: "deliver" },
      { kind: "place", client: 1, note: 1, x: 9, y: 9, fate: "lose_response" },
    ],
  },
  // FIXED (found by the simulator): a drag whose reply was lost was applied again on retry, over a
  // newer drag from the other device. PUT /api/nodes/:id/position now claims its Idempotency-Key.
  "a retried drag does not overwrite a newer drag from the other device": {
    note: "Device B drags a note and the reply is lost; device A drags it elsewhere; B's retry (same key) is acknowledged and A's position stays.",
    ops: [
      { kind: "place", client: 1, note: 1, x: 0, y: 0, fate: "lose_response" },
      { kind: "place", client: 0, note: 1, x: 498, y: 444, fate: "deliver" },
      { kind: "online", client: 1, fates: [] },
    ],
  },
  "a drawing saved offline and one saved online both keep their strokes (three-way merge by id)": {
    note: "Device A draws offline, device B draws online on the same page; on reconnect the server merges A's save into B's drawing; an erase and an undo on one device also survive the other's save.",
    ops: [
      { kind: "draw", client: 1, note: 1, fate: "deliver" },
      { kind: "online", client: 0, fates: [] },
      { kind: "offline", client: 0 },
      { kind: "draw", client: 0, note: 1, fate: "deliver" },
      { kind: "eraseInk", client: 1, note: 1, stroke: 0, at: 1, fate: "deliver" },
      { kind: "draw", client: 1, note: 1, fate: "deliver" },
      { kind: "undoStroke", client: 1, note: 1, stroke: 1, fate: "deliver" },
      { kind: "online", client: 0, fates: [] },
    ],
  },
  "two devices ticking off the same repeating task leave one next occurrence": {
    note: "Device B ticks the task off while offline; device A ticks it off online; on reconnect B's tick finds it done and mints nothing.",
    ops: [
      { kind: "createTask", client: 0, note: 1, recurring: true, day: 0, fate: "deliver" },
      { kind: "online", client: 1, fates: [] },
      { kind: "offline", client: 1 },
      { kind: "patchTask", client: 1, task: 0, how: "complete", day: 0, fate: "deliver" },
      { kind: "patchTask", client: 0, task: 0, how: "complete", day: 0, fate: "deliver" },
      { kind: "online", client: 1, fates: [] },
    ],
  },
  // A repeating task mints its next occurrence once, ever (update.ts, "M9"): the tick of a reopened
  // task mints nothing (reopening does not take the minted one back: that could delete edits made to it).
  "ticking a repeating task off, reopening and ticking it off again leaves one next occurrence": {
    strictOccurrences: true,
    note: "Device A adds a daily repeating task, ticks it off, un-ticks it and ticks it off again; the server holds one next occurrence.",
    ops: [
      { kind: "createTask", client: 0, note: 1, recurring: true, day: 0, fate: "deliver" },
      { kind: "patchTask", client: 0, task: 0, how: "complete", day: 0, fate: "deliver" },
      { kind: "patchTask", client: 0, task: 0, how: "reopen", day: 0, fate: "deliver" },
      { kind: "patchTask", client: 0, task: 0, how: "complete", day: 0, fate: "deliver" },
    ],
  },
};

// FIXED (found by the simulator, 1000 runs): removing a property that is not there wrote nothing and so claimed no
// Idempotency-Key; the retry after a lost reply then ran again and removed the value another device had set meanwhile.
// DELETE /api/nodes/:id/attributes/:key now spends its key even when it removed nothing (spine/idempotency spendIdempotencyKey).
REGRESSIONS["retrying a removal of a property that was not there does not remove a newer value"] = {
  note: "Device B removes a property nobody has set (nothing to remove) and the reply is lost; device A sets it; B's retry (same key) is acknowledged and A's value stays.",
  ops: [
    { kind: "removeAttr", client: 1, note: 1, key: 0, fate: "lose_response" },
    { kind: "setAttr", client: 0, note: 1, key: 0, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
  ],
};

REGRESSIONS["retrying a task change that changed nothing does not undo a newer change"] = {
  note: "Device B sets a task's day to the day it already has (nothing changes) and the reply is lost; device A moves the task to another day; B's retry (same key) is acknowledged and A's day stays.",
  ops: [
    { kind: "createTask", client: 0, note: 1, recurring: false, day: 0, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
    { kind: "patchTask", client: 1, task: 0, how: "reschedule", day: 0, fate: "lose_response" },
    { kind: "patchTask", client: 0, task: 0, how: "reschedule", day: 1, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
  ],
};

// DELAY AND REORDER (pinned scenarios).
REGRESSIONS["a delayed original arriving after its retry and a newer drag from another device changes nothing"] = {
  note: "Device B's drag is delayed (it retries and is answered), device A drags it elsewhere, then B's original arrives: the key is spent, A's position stays.",
  ops: [
    { kind: "place", client: 1, note: 1, x: 3, y: 3, fate: "delay" },
    { kind: "online", client: 1, fates: [] },
    { kind: "place", client: 0, note: 1, x: 498, y: 444, fate: "deliver" },
    { kind: "deliverLate", client: 0, pick: 0 },
  ],
};
REGRESSIONS["a delayed edit arriving after another device's delete does not bring the note back"] = {
  note: "Device B saves an edit that is delayed; device A deletes the note; the edit arrives: refused, the note stays deleted.",
  ops: [
    { kind: "edit", client: 1, note: 1, how: "insert", at: 0, fate: "delay" },
    { kind: "delete", client: 0, note: 1, fate: "deliver" },
    { kind: "deliverLate", client: 0, pick: 0 },
  ],
};

// BOARD CARDS (pinned scenarios). A board is a note with a whiteboard; its cards are written by PATCH /api/boards/:id.
// Checked for the bug #1379 found on the graph (a retried drag overwrote a newer one): the board change runs in one
// mutate(), which claims the Idempotency-Key, so the retry is acknowledged and not applied again. No bug here.
REGRESSIONS["a retried card drag on a board does not overwrite a newer drag from the other device"] = {
  note: "Device B drags a card and the reply is lost; device A drags the same card elsewhere; B's retry (same key) is acknowledged and A's position stays.",
  ops: [
    { kind: "arrangeCard", client: 1, board: 0, note: 1, how: "move", x: 0, y: 0, fate: "lose_response" },
    { kind: "arrangeCard", client: 0, board: 0, note: 1, how: "move", x: 498, y: 444, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
  ],
};
REGRESSIONS["a retried resize and fold of a card do not undo the other device's later change"] = {
  note: "Device B resizes a card (reply lost) and folds it; device A recolours the card in between; the retries are acknowledged and the last accepted change of each field set stands.",
  ops: [
    { kind: "arrangeCard", client: 1, board: 0, note: 1, how: "resize", x: 10, y: 10, fate: "lose_response" },
    { kind: "arrangeCard", client: 0, board: 0, note: 1, how: "color", x: 1, y: 0, fate: "deliver" },
    { kind: "arrangeCard", client: 1, board: 0, note: 1, how: "fold", x: 0, y: 0, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
  ],
};
REGRESSIONS["a delayed card change arriving after the card was taken off the board does not put it back"] = {
  note: "Device B drags a card, delayed; device A takes the card off; B's original arrives (its retry came first): the card stays off.",
  ops: [
    { kind: "arrangeCard", client: 0, board: 0, note: 1, how: "move", x: 1, y: 1, fate: "deliver" },
    { kind: "arrangeCard", client: 1, board: 0, note: 1, how: "move", x: 7, y: 7, fate: "delay" },
    { kind: "online", client: 1, fates: [] },
    { kind: "removeCard", client: 0, board: 0, note: 0, fate: "deliver" },
    { kind: "deliverLate", client: 0, pick: 0 },
  ],
};

// TASKS, REVIEW AND SAVED VIEWS (pinned scenarios, then the two defects the simulator's review check finds). Each case folds several
// facts into one run because a case costs seconds once the file's shared workspace has grown.
// Notes are "visible note #n" counted from the oldest: the run starts with three (#0, #1, and #2 under #0).
const REVIEW_TWO_DEVICES: Op[] = [
  { kind: "setCard", client: 0, note: 0, on: true, fate: "deliver" },
  { kind: "reviewOpen", client: 0 },
  { kind: "reviewOpen", client: 1 },
];
REGRESSIONS["a grade and an undo whose replies were lost are retried with their keys and count once"] = {
  strictRetry: true, strictUndo: true, strictGradeOnce: true,
  note: "Two notes are review cards. A's grade is applied but its reply is lost; B grades the other card and its undo's reply is lost; C puts a card off until tomorrow. Each retry (same key) is acknowledged: one review each, the undone card is new again, the hold leaves schedules alone.",
  ops: [
    { kind: "setCard", client: 0, note: 0, on: true, fate: "deliver" },
    { kind: "setCard", client: 0, note: 1, on: true, fate: "deliver" },
    { kind: "grade", client: 0, card: 0, rating: 3, fate: "lose_response" },
    { kind: "grade", client: 1, card: 1, rating: 2, fate: "deliver" },
    { kind: "undoGrade", client: 1, fate: "lose_response" },
    { kind: "tomorrow", client: 2, card: 0, fate: "deliver" },
  ],
};
REGRESSIONS["a task without a note and a checkbox line ticked and un-ticked from several devices end as the last accepted requests say"] = {
  strictRetry: true, strictOccurrences: true,
  note: "A task that belongs to no note is ticked on B (reply lost) and reopened and cleared on A; a checkbox line is ticked on both A and B while offline and C edits the note meanwhile: every device ends with the server's task, and the line is ticked once.",
  ops: [
    { kind: "createLooseTask", client: 0, day: 1, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
    { kind: "patchTask", client: 1, task: 0, how: "complete", day: 0, fate: "lose_response" },
    { kind: "patchTask", client: 0, task: 0, how: "reopen", day: 0, fate: "deliver" },
    { kind: "patchTask", client: 0, task: 0, how: "unschedule", day: 0, fate: "deliver" },
    { kind: "checkbox", client: 0, note: 1, how: "add", at: 0, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
    { kind: "offline", client: 0 }, { kind: "offline", client: 1 },
    { kind: "checkbox", client: 0, note: 1, how: "tick", at: 0, fate: "deliver" },
    { kind: "checkbox", client: 1, note: 1, how: "tick", at: 0, fate: "deliver" },
    { kind: "edit", client: 2, note: 1, how: "insert", at: 0, fate: "deliver" },
    { kind: "online", client: 0, fates: [] }, { kind: "online", client: 1, fates: [] },
  ],
};
REGRESSIONS["saved views: a create with a lost reply exists once, a late change after a delete is refused, different keys changed from two devices keep both"] = {
  strictRetry: true,
  note: "On a note, A saves a view and the reply is lost; B changes its grouping and deletes it; A's rename is refused and its create is retried (acknowledged, not made again). On a tag, A saves a view, B changes its filters while A changes its sorts and columns, and B's grouping reply is lost: the server merges the keys each request sent and every device shows what it stores.",
  ops: [
    { kind: "view", client: 0, owner: "note", of: 1, how: "create", pick: 0, n: 0, fate: "lose_response" },
    { kind: "view", client: 1, owner: "note", of: 1, how: "group", pick: 0, n: 1, fate: "deliver" },
    { kind: "view", client: 1, owner: "note", of: 1, how: "delete", pick: 0, n: 0, fate: "deliver" },
    { kind: "view", client: 0, owner: "note", of: 1, how: "rename", pick: 0, n: 0, fate: "deliver" },
    { kind: "view", client: 0, owner: "tag", of: 0, how: "create", pick: 0, n: 0, fate: "deliver" },
    { kind: "view", client: 1, owner: "tag", of: 0, how: "filter", pick: 0, n: 4, fate: "deliver" },
    { kind: "view", client: 0, owner: "tag", of: 0, how: "sort", pick: 0, n: 4, fate: "deliver" },
    { kind: "view", client: 0, owner: "tag", of: 0, how: "fields", pick: 0, n: 5, fate: "deliver" },
    { kind: "view", client: 1, owner: "tag", of: 0, how: "group", pick: 0, n: 1, fate: "lose_response" },
    { kind: "online", client: 1, fates: [] },
  ],
};
REGRESSIONS["whiteboard settings: a queued setting change made offline does not wipe the key another device set meanwhile"] = {
  strictRetry: true,
  note: "A saves a view; B reads it and sets one key of its layout_config, then goes offline. A sets another key. B, still offline, changes its own key again (the change queues as a per-key patch) and reconnects: the server keeps A's key and takes B's. An older client's whole-object write replaces the config, as before.",
  ops: [
    { kind: "view", client: 0, owner: "note", of: 1, how: "create", pick: 0, n: 0, fate: "deliver" },
    { kind: "view", client: 1, owner: "note", of: 1, how: "setting", pick: 0, n: 1, fate: "deliver" },
    { kind: "offline", client: 1 },
    { kind: "view", client: 0, owner: "note", of: 1, how: "setting", pick: 0, n: 2, fate: "deliver" },
    { kind: "view", client: 1, owner: "note", of: 1, how: "setting", pick: 0, n: 4, fate: "deliver" },
    { kind: "online", client: 1, fates: [] },
    { kind: "view", client: 0, owner: "note", of: 1, how: "settingWhole", pick: 0, n: 5, fate: "deliver" },
  ],
};
// KNOWN DEFECTS the review check finds (modules/review/service.ts, state.ts). They run as `it.fails` and the property run leaves the two
// strict flags off until the server is fixed; then each case goes red (remove knownFailure) and the flags go on in both test files.
REGRESSIONS["the same card graded from two devices that showed it counts one review (known defect)"] = {
  knownFailure: true, strictGradeOnce: true,
  note: "Devices A and B both show a new card; A grades it, then B grades it from its stale screen: the server advances the schedule a second time (reps 2) for one showing of the card.",
  ops: [
    ...REVIEW_TWO_DEVICES,
    { kind: "grade", client: 0, card: 0, rating: 3, fate: "deliver" },
    { kind: "grade", client: 1, card: 0, rating: 3, fate: "deliver" },
  ],
};
REGRESSIONS["an undo right after another device's undo does not delete the schedule of a card that had earlier reviews (known defect)"] = {
  strictUndo: true,
  note: "A and B grade the same card (both counted), A undoes its grade (the earlier schedule comes back), then B undoes with a different key: the server steps back again and deletes the card's schedule.",
  ops: [
    ...REVIEW_TWO_DEVICES,
    { kind: "grade", client: 0, card: 0, rating: 3, fate: "deliver" },
    { kind: "grade", client: 1, card: 0, rating: 3, fate: "deliver" },
    { kind: "undoGrade", client: 0, fate: "deliver" },
    { kind: "undoGrade", client: 1, fate: "deliver" },
  ],
};


/** The members run's pinned scenarios (syncSimulatorMembers.integration.test.ts): A owner, B edit member, C view-only member. */
export const MEMBER_REGRESSIONS: Record<string, Case> = {
  "a view-only member's edit is refused and kept for recovery, the editing member's lands": {
    note: "Device C (view only) saves an edit and gets 403; device B (edit) saves one and it lands.",
    ops: [
      { kind: "edit", client: 2, note: 0, how: "insert", at: 0, fate: "deliver" },
      { kind: "edit", client: 1, note: 0, how: "insert", at: 0, fate: "deliver" },
    ],
  },
  "a member removed while offline with queued writes: the writes are refused and the notes leave the device": {
    note: "Device B goes offline and queues an edit; the owner removes B from the space; B reconnects: its edit is refused (403, kept for recovery) and the shared notes are removed from the device.",
    ops: [
      { kind: "offline", client: 1 },
      { kind: "edit", client: 1, note: 0, how: "insert", at: 0, fate: "deliver" },
      { kind: "setMember", client: 0, member: 1, permission: "none" },
      { kind: "online", client: 1, fates: [] },
    ],
  },
  "a member whose permission drops to view while offline: queued writes are refused": {
    note: "Device B queues an edit offline; the owner lowers B to view; B reconnects: refused, and B still reads the notes.",
    ops: [
      { kind: "offline", client: 1 },
      { kind: "edit", client: 1, note: 0, how: "insert", at: 0, fate: "deliver" },
      { kind: "setMember", client: 0, member: 1, permission: "view" },
      { kind: "online", client: 1, fates: [] },
    ],
  },
  "a view-only member raised to edit can write; a removed member added back gets the notes again": {
    note: "Device C is raised to edit and its edit lands; device B is removed, then added back and reads the notes again.",
    ops: [
      { kind: "setMember", client: 0, member: 2, permission: "edit" },
      { kind: "edit", client: 2, note: 0, how: "insert", at: 0, fate: "deliver" },
      { kind: "setMember", client: 0, member: 1, permission: "none" },
      { kind: "online", client: 1, fates: [] },
      { kind: "setMember", client: 0, member: 1, permission: "edit" },
      { kind: "online", client: 1, fates: [] },
    ],
  },
  // Found by the members run (1000 runs), the same root cause as the task case in REGRESSIONS: a PATCH that changed nothing
  // claimed no key, so its retry after the person was lowered to view ran again and was refused (403) instead of acknowledged.
  "retrying a task change that changed nothing after the person was lowered to view is acknowledged, not refused": {
    strictRetry: true,
    note: "Device B sets a task's day to the one it has (nothing changes), the reply is lost; the owner lowers B to view; B's retry (same key) is answered as done, not 403.",
    ops: [
      { kind: "createTask", client: 1, note: 0, recurring: false, day: 0, fate: "deliver" },
      { kind: "patchTask", client: 1, task: 0, how: "reschedule", day: 0, fate: "lose_response" },
      { kind: "setMember", client: 0, member: 1, permission: "view" },
      { kind: "online", client: 1, fates: [] },
    ],
  },
  // KNOWN FAILURE — found by the members run. Changes made while a person is not a member are not in their delta
  // (events they may not read are left out) but their sync cursor moves past them. If the device never reconciled
  // the removal (its membership request failed) and the person is added back, the membership check compares id
  // sets, finds nothing new to fetch, and the device keeps the old copy of every note for good.
  // Fixing it means the epoch change must refetch (or re-diff) what a device held across a window without read access
  // — a membership-protocol decision (docs/architecture/membership-and-permission-epoch.md), so not a quick fix.
  "a member removed and added back before the device reconciled the removal keeps stale notes": {
    knownFailure: true, membershipFaults: true,
    note: "Device B syncs while removed but its membership check is lost; the owner changes a property meanwhile and adds B back; B never gets the property.",
    ops: [
      { kind: "setMember", client: 0, member: 1, permission: "none" },
      { kind: "setAttr", client: 0, note: 1, key: 0, fate: "deliver" },
      { kind: "online", client: 1, fates: ["deliver", "lose_request"] },
      { kind: "setMember", client: 0, member: 1, permission: "edit" },
    ],
  },
  // The merge read an emptied server body as "ends with a newline", so the other device's insertion came back as
  // "B4\n": a blank last line nobody typed. The device then saved it (accepted), and a later merge trimmed it again,
  // which the invariant reported as the lost line "". Fixed in bodyMerge.ts (an empty side has no ending); pinned
  // there by "an emptied body has no ending to keep".
  "a body another device emptied does not gain a trailing blank line that a later merge drops": {
    note: "A deletes the only line of a note; B, offline, inserted a line above it and saves on reconnect; B adds another line; A, still on the empty body, adds a line.",
    ops: [
      { kind: "offline", client: 1 },
      { kind: "edit", client: 0, note: 1, how: "delete", at: 0, fate: "deliver" },
      { kind: "edit", client: 1, note: 1, how: "insert", at: 0, fate: "deliver" },
      { kind: "online", client: 1, fates: [] },
      { kind: "edit", client: 1, note: 1, how: "insert", at: 1, fate: "deliver" },
      { kind: "edit", client: 0, note: 1, how: "insert", at: 0, fate: "deliver" },
    ],
  },
};
