// What must hold once every device are online, flushed and pulled. Every
// check reads the server's own tables (scoped to this run's workspace), never
// only the replies the devices saw.
import { q } from "../../../db.js";
import { taskRowsByIds, type TaskRow as ServerTask } from "../../../services/tasksStore.js";
import { K } from "../../../spine/taskIdentity.js";
import { decodeInk } from "@onden/markdown/ink";
import { noteIdOf, NOTE_PATH, OFFLINE_EDIT_AGE_MS, INK_ATTR } from "./client.js";
import { ATTR_KEYS, splitBody, type World } from "./ops.js";

type ServerNote = { id: string; title: string; markdown: string; parent_id: string | null; deleted: boolean; node_type: string; tags: string[] };

/** This run's notes and tags, plus every parent they name (the workspace is shared with other runs). */
export async function serverNotes(workspaceId: string, ids: string[]): Promise<Map<string, ServerNote>> {
  const found = new Map<string, ServerNote>();
  for (let todo = ids; todo.length; ) {
    const rows = await q<ServerNote>(
      `SELECT n.id::text, n.title, n.markdown, n.parent_id::text, (n.deleted_at IS NOT NULL) AS deleted, n.node_type,
              COALESCE((SELECT array_agg(t.tag_id::text ORDER BY t.tag_id) FROM node_tags t WHERE t.node_id = n.id), '{}') AS tags
         FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[])`, [workspaceId, todo]);
    rows.rows.forEach((r) => found.set(r.id, r));
    todo = [...new Set(rows.rows.map((r) => r.parent_id).filter((p): p is string => !!p && !found.has(p)))];
  }
  return found;
}

/** Text of every BODY_CONFLICT the server recorded for a note (the inbox entry). */
async function conflictText(workspaceId: string, noteId: string): Promise<string[]> {
  const rows = await q<{ payload: unknown }>(
    `SELECT payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'BODY_CONFLICT' AND target_id = $2`, [workspaceId, noteId]);
  const lines: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") lines.push(...splitBody(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  rows.rows.forEach((r) => walk(r.payload));
  return lines;
}

export type Checks = {
  /** A retry of an applied write (same Idempotency-Key) must be answered as a success.
   *  On everywhere: the replay shield in app.ts acknowledges a committed key before any route check. */
  strictRetry?: boolean;
  /** A repeating task ticked off, reopened and ticked off again leaves ONE next occurrence, not two.
   *  Off in the property run while the server mints one per tick (REGRESSIONS names the case). */
  strictOccurrences?: boolean;
  /** An undo right after an undo (another device, another key) steps back nothing: it must not delete or change the schedule of a card
   *  that had earlier reviews. Off in the property run while the server accepts it (REGRESSIONS names the case). */
  strictUndo?: boolean;
  /** One showing of a card is one human review: grading the same card again from a device that still showed the same schedule
   *  (another device, another key) must not advance it a second time. Off in the property run while the server counts both. */
  strictGradeOnce?: boolean;
};

export async function checkInvariants(world: World, workspaceId: string, checks: Checks = {}): Promise<void> {
  const problems: string[] = [];
  const mine = [...world.ordinal.keys()];
  const server = await serverNotes(workspaceId, [...mine, ...world.tagIds]);
  const L = (id: string) => world.label(id);
  const simTags = new Set(world.tagIds);

  // ── Convergence: every device equals the others and the server ──────────
  for (const c of world.clients) {
    if (c.queue.length) problems.push(`device ${c.name} still has ${c.queue.length} queued writes`);
    for (const id of mine) {
      const s = server.get(id);
      const row = c.mirror.get(id);
      if (!world.mayRead(c)) { if (row) problems.push(`${L(id)}: device ${c.name} still holds a note its person may not read (membership revoked, and the device has synced since)`); continue; }
      if (!s || s.deleted) { if (row) problems.push(`${L(id)}: device ${c.name} still shows a note the server has ${s ? "deleted" : "never kept"}`); continue; }
      if (!row) { problems.push(`${L(id)}: device ${c.name} does not have a live note the server has`); continue; }
      const tags = [...(row.label_tag_ids ?? [])].filter((t) => simTags.has(t)).sort();
      const sTags = s.tags.filter((t) => simTags.has(t));
      for (const [field, got, want] of [["title", row.title, s.title], ["body", row.markdown, s.markdown], ["parent", row.parent_id, s.parent_id], ["tags", tags.join(), sTags.join()]] as const) {
        if (got !== want) problems.push(`${L(id)}: device ${c.name}'s ${field} differs from the server: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
      }
    }
  }

  // ── Tree sanity ────────────────────────────────────────────────────────
  for (const n of server.values()) {
    if (n.node_type === "class_tag" || !n.parent_id) continue;
    const parent = server.get(n.parent_id);
    if (!parent) problems.push(`${L(n.id)}: parent row is missing`);
    else if (parent.node_type === "class_tag") problems.push(`${L(n.id)}: parented to a tag`);
    else if (!n.deleted && parent.deleted) problems.push(`${L(n.id)}: live note under deleted ${L(parent.id)}`);
    const seen = new Set<string>([n.id]);
    for (let p: string | null = n.parent_id; p; p = server.get(p)?.parent_id ?? null) {
      if (seen.has(p)) { problems.push(`${L(n.id)}: parent chain has a cycle`); break; }
      seen.add(p);
    }
  }

  // ── No silent loss / no duplication ────────────────────────────────────
  // A save the server refused is kept by the device (recovery); its text is not owed to the body
  // even when the editor's next save still carries it.
  const inRecovery = new Set<string>();
  const added = (h: { body: Record<string, unknown> | null }): string[] => {
    if (typeof h.body?.markdown !== "string") return [];
    const base = new Set(typeof h.body.base_markdown === "string" ? splitBody(h.body.base_markdown) : []);
    return splitBody(h.body.markdown).filter((l) => !base.has(l));
  };
  for (const h of world.server.handled) if (h.status >= 400) added(h).forEach((l) => inRecovery.add(l));
  const owed = new Map<string, Set<string>>(); // note -> lines of accepted writes
  for (const h of world.server.handled) {
    if (h.status >= 300 || !h.body) continue;
    const id = h.method === "POST" && h.path === "/api/nodes" ? (h.body.id as string) : noteIdOf(h.path);
    if (!id || typeof h.body.markdown !== "string") continue;
    const set = owed.get(id) ?? new Set<string>();
    splitBody(h.body.markdown).filter((l) => !inRecovery.has(l)).forEach((l) => set.add(l));
    owed.set(id, set);
  }
  for (const [id, lines] of owed) {
    const s = server.get(id);
    if (!s) { problems.push(`${L(id)}: a saved note is gone from the server`); continue; }
    const body = splitBody(s.markdown);
    const inBody = new Map<string, number>();
    body.forEach((l) => inBody.set(l, (inBody.get(l) ?? 0) + 1));
    for (const [line, count] of inBody) if (count > 1) problems.push(`${L(id)}: line "${line}" appears ${count} times in the final body (duplicated text)`);
    const missing = [...lines].filter((l) => !inBody.has(l) && !world.removedLines.has(l));
    if (missing.length) {
      const kept = new Set(await conflictText(workspaceId, id));
      const lost = missing.filter((l) => !kept.has(l));
      if (lost.length) problems.push(`${L(id)}: saved lines ${JSON.stringify(lost)} are in neither the final body nor its BODY_CONFLICT entry`);
    }
  }

  // ── A retry after a lost reply is answered as the success it was ───────
  if (checks.strictRetry) {
  const firstAccepted = new Map<string, number>();
  for (const h of world.server.handled) {
    if (!h.idemKey) continue;
    if (h.status < 300 && !firstAccepted.has(h.idemKey)) firstAccepted.set(h.idemKey, h.seq);
    else if (firstAccepted.has(h.idemKey) && h.status >= 300) {
      problems.push(`retry of an applied write was refused (${h.status}): ${h.method} ${h.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => L(id))} (device ${h.client}, same Idempotency-Key)`);
    }
  }
  }

  // ── Deletes: only by a delete nobody undid ─────────────────────────────
  const ancestors = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    const todo = [id];
    while (todo.length) for (const p of world.parentsEver.get(todo.pop()!) ?? []) if (p && !out.has(p)) { out.add(p); todo.push(p); }
    return out;
  };
  // A replayed Idempotency-Key is answered without applying the write again: only its first acceptance counts.
  const firstKeys = new Set<string>();
  const accepted = world.server.handled.filter((h) => h.status < 300 && !firstKeys.has(h.idemKey) && !!firstKeys.add(h.idemKey));
  for (const id of mine) {
    const s = server.get(id);
    if (!s) continue;
    const family = ancestors(id);
    const covering = accepted.filter((h) => {
      const t = noteIdOf(h.path);
      return t && family.has(t) && (h.method === "DELETE" && NOTE_PATH.test(h.path) || h.path.endsWith("/undelete"));
    });
    const lastDelete = [...covering].reverse().find((h) => h.method === "DELETE");
    if (s.deleted && !lastDelete) problems.push(`${L(id)}: deleted, but no accepted delete covers it`);
    const direct = covering.filter((h) => noteIdOf(h.path) === id);
    const last = direct[direct.length - 1];
    const revivedByDescendant = accepted.some((h) => last && h.seq > last.seq && h.path.endsWith("/undelete") && ancestors(noteIdOf(h.path)!).has(id));
    if (!s.deleted && last?.method === "DELETE" && !revivedByDescendant) problems.push(`${L(id)}: live although its last accepted request was a delete`);
    if (s.deleted && last?.path.endsWith("/undelete") && !covering.some((h) => h.seq > last.seq && h.method === "DELETE" && noteIdOf(h.path) !== id)) {
      problems.push(`${L(id)}: still deleted although restored afterwards and nothing deleted it again`);
    }
  }

  checkDeviceOrder(world, problems);
  checkMembers(world, problems);
  await checkAttributes(world, workspaceId, problems, mine);
  await checkTasks(world, workspaceId, problems, checks);
  await checkCheckboxes(world, workspaceId, problems, server);
  await checkReview(world, workspaceId, problems, checks);
  await checkViews(world, workspaceId, problems);
  await checkPositions(world, workspaceId, problems, mine);
  await checkInk(world, workspaceId, problems, mine);
  await checkBoards(world, workspaceId, problems, mine);

  if (problems.length) throw new Error(`sync invariants broken:\n  - ${problems.join("\n  - ")}`);
}

// ── Properties (node_attributes) ─────────────────────────────────────────
// The server's rule (services/attributeWrites.ts setNodeAttribute): last writer wins, in the order
// the server handled the requests; a write whose `client_updated_at` is more than 500 ms older
// than the stored value it replaces still lands but is recorded as an ATTRIBUTE_CONFLICT.
const attrKeyOf = (path: string) => decodeURIComponent(path.split("/attributes/")[1] ?? "");

async function checkAttributes(world: World, workspaceId: string, problems: string[], mine: string[]): Promise<void> {
  const L = (id: string) => world.label(id);
  const keys = new Set<string>(ATTR_KEYS);
  const stored = await q<{ node_id: string; key: string; value: string }>(
    `SELECT node_id::text, key, value FROM node_attributes WHERE workspace_id = $1 AND node_id = ANY($2::uuid[]) AND key = ANY($3::text[])`,
    [workspaceId, mine, [...keys]]);
  const server = new Map(stored.rows.map((r) => [`${r.node_id}:${r.key}`, r.value]));

  // Convergence: every device's copy of the property equals the server's.
  for (const c of world.clients) {
    for (const id of mine) {
      const row = c.mirror.get(id);
      if (!row || !world.mayRead(c)) continue; // a deleted or unreadable note: the note checks above cover it
      for (const key of keys) {
        const got = row.attrs?.[key];
        const want = server.get(`${id}:${key}`);
        if (got !== want) problems.push(`${L(id)}: device ${c.name}'s property "${key}" is ${JSON.stringify(got)} but the server has ${JSON.stringify(want)}`);
      }
    }
  }

  // Last writer wins, nothing accepted is dropped: the server's value is the last accepted write.
  const firstKeys = new Set<string>();
  const accepted = world.server.handled.filter((h) => h.status < 300 && h.path.includes("/attributes/") && !firstKeys.has(h.idemKey) && !!firstKeys.add(h.idemKey));
  const expected = new Map<string, string | undefined>();
  const conflictsOwed: Array<{ note: string; key: string; seq: number }> = [];
  for (const h of accepted) {
    const id = noteIdOf(h.path)!;
    const key = attrKeyOf(h.path);
    if (!keys.has(key)) continue;
    const slot = `${id}:${key}`;
    // The reply is the server's, even when the device never saw it.
    const conflict = (h.reply as { conflict?: unknown } | null)?.conflict;
    const stale = h.method === "PUT" && Date.parse(String(h.body?.client_updated_at)) < Date.now() - OFFLINE_EDIT_AGE_MS / 2;
    if (conflict) conflictsOwed.push({ note: id, key, seq: h.seq });
    else if (stale && expected.get(slot) !== undefined) {
      problems.push(`${L(id)}: an edit of "${key}" made long before it arrived replaced a newer value without the server recording a conflict (request ${h.seq + 1})`);
    }
    expected.set(slot, h.method === "PUT" ? (h.body as { value: string }).value : undefined);
  }
  for (const [slot, want] of expected) {
    const got = server.get(slot);
    if (got !== want) problems.push(`${L(slot.split(":")[0]!)}: property "${slot.split(":")[1]}" is ${JSON.stringify(got)} on the server although the last accepted write ${want === undefined ? "removed it" : `set ${JSON.stringify(want)}`}`);
  }

  // A conflict the server announced is on record.
  const events = await q<{ target_id: string; key: string }>(
    `SELECT target_id, payload->>'key' AS key FROM domain_events WHERE workspace_id = $1 AND event_type = 'ATTRIBUTE_CONFLICT' AND target_id = ANY($2::text[])`, [workspaceId, mine]);
  const recorded = new Map<string, number>();
  for (const e of events.rows) recorded.set(`${e.target_id}:${e.key}`, (recorded.get(`${e.target_id}:${e.key}`) ?? 0) + 1);
  for (const o of conflictsOwed) if (!recorded.get(`${o.note}:${o.key}`)) problems.push(`${L(o.note)}: the server told device of a conflict on "${o.key}" (request ${o.seq + 1}) but no ATTRIBUTE_CONFLICT event is recorded`);
}

// ── Tasks ────────────────────────────────────────────────────────────────
// Server rules (docs/architecture/tasks-module.md, modules/tasks/update.ts): a task is a hidden
// node under its note; its fields are last-writer-wins attributes; ticking a repeating task off
// mints the next occurrence in the same transaction (NODE_CREATED with `rolled_from`), and the
// delta ships a task only while its note is live.
async function checkTasks(world: World, workspaceId: string, problems: string[], checks: Checks): Promise<void> {
  const tag = (id: string) => `task#${world.taskOrdinal.get(id) ?? "?"}`;
  const firstKeys = new Set<string>();
  const accepted = world.server.handled.filter((h) => h.status < 300 && !firstKeys.has(h.idemKey) && !!firstKeys.add(h.idemKey));
  const taskIdOf = (path: string) => /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(path)?.[1] ?? null;
  const created = accepted.filter((h) => h.method === "POST" && (h.path === "/api/tasks" || (h.path.endsWith("/tasks") && h.path.startsWith("/api/nodes/"))));
  const known = new Set(created.map((h) => h.body!.id as string));

  // The occurrences the server minted: follow `rolled_from` until nothing new turns up.
  const minted = new Map<string, string[]>(); // task -> the occurrences minted from it
  for (let todo = [...known]; todo.length; ) {
    const rows = await q<{ target_id: string; from: string }>(
      `SELECT target_id, payload->>'rolled_from' AS "from" FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_CREATED' AND payload->>'rolled_from' = ANY($2::text[]) ORDER BY id`, [workspaceId, todo]);
    todo = [];
    for (const r of rows.rows) {
      minted.set(r.from, [...(minted.get(r.from) ?? []), r.target_id]);
      if (!known.has(r.target_id)) { known.add(r.target_id); todo.push(r.target_id); }
    }
  }

  // Nothing accepted is dropped: the task exists, with the last accepted value of each field.
  const attrs = await q<{ node_id: string; key: string; value: string; deleted: boolean }>(
    `SELECT a.node_id::text, a.key, a.value, (n.deleted_at IS NOT NULL) AS deleted FROM node_attributes a JOIN content_nodes n ON n.id = a.node_id
      WHERE a.workspace_id = $1 AND a.node_id = ANY($2::uuid[]) AND a.key = ANY($3::text[])`, [workspaceId, [...known], [K.status, K.when]]);
  const stored = new Map(attrs.rows.map((r) => [`${r.node_id}:${r.key}`, r.value]));
  const expected = new Map<string, { status: string; when: string | null }>();
  for (const h of created) expected.set(h.body!.id as string, { status: "todo", when: (h.body!.when_date as string | undefined) ?? null });
  for (const h of accepted) {
    const id = h.method === "PATCH" ? taskIdOf(h.path) : null;
    const e = id && expected.get(id);
    if (!e || !h.body) continue;
    if (typeof h.body.status === "string") e.status = h.body.status;
    if ("when_date" in h.body) e.when = h.body.when_date as string | null;
  }
  for (const [id, e] of expected) {
    if (!stored.has(`${id}:${K.status}`)) { problems.push(`${tag(id)}: a task the server accepted is gone`); continue; }
    const got = { status: stored.get(`${id}:${K.status}`), when: stored.get(`${id}:${K.when}`) ?? null };
    if (got.status !== e.status || got.when !== e.when) problems.push(`${tag(id)}: the server has ${JSON.stringify(got)} but the last accepted writes say ${JSON.stringify(e)}`);
  }

  // No duplicate occurrence. The server's rule (update.ts, M9): a task mints its next occurrence once,
  // ever: a later tick (the other device's replayed, or after a reopen) mints nothing. With
  // `strictOccurrences` the check is that rule (at most one); without it, the older bound of one per tick
  // that found the task open.
  const status = new Map<string, string>([...known].map((id) => [id, "todo"])); // created, or minted (born open)
  const recurring = new Set(created.filter((h) => h.body!.recur).map((h) => h.body!.id as string));
  for (const from of minted.keys()) recurring.add(from); // minted occurrences repeat too
  const ticks = new Map<string, number>();
  for (const h of accepted) {
    const id = h.method === "PATCH" ? taskIdOf(h.path) : null;
    if (!id || !status.has(id) || typeof h.body?.status !== "string") continue;
    if (h.body.status === "done" && status.get(id) !== "done" && status.get(id) !== "cancelled") ticks.set(id, (ticks.get(id) ?? 0) + 1);
    status.set(id, h.body.status);
  }
  for (const [from, next] of minted) {
    const allowed = checks.strictOccurrences ? 1 : (recurring.has(from) ? ticks.get(from) ?? 0 : 0);
    if (next.length > allowed) problems.push(`${tag(from)}: ${next.length} next occurrences were minted from one repeating task (${checks.strictOccurrences ? "ticked off, reopened and ticked off again" : `it was ticked off from open ${ticks.get(from) ?? 0} time(s)`})`);
  }

  // Convergence: each device holds exactly the tasks the server ships (live note), with the same fields.
  const server = new Map((await taskRowsByIds(workspaceId, [...known])).map((r: ServerTask) => [r.id, r]));
  for (const c of world.clients) {
    for (const id of known) {
      const row = c.tasks.get(id);
      if (!world.mayRead(c)) { if (row) problems.push(`${tag(id)}: device ${c.name} still holds a task its person may not read`); continue; }
      const s = server.get(id);
      if (!s) { if (row) problems.push(`${tag(id)}: device ${c.name} still shows a task the server no longer lists`); continue; }
      if (!row) { problems.push(`${tag(id)}: device ${c.name} does not have a task the server lists`); continue; }
      for (const field of ["title", "status", "when_date", "recur", "node_id"] as const) {
        if (row[field] !== s[field]) problems.push(`${tag(id)}: device ${c.name}'s ${field} is ${JSON.stringify(row[field])} but the server has ${JSON.stringify(s[field])}`);
      }
    }
  }
}

// ── Checkbox lines (a plain `- [ ] A7` line of a note's body) ─────────────
// No server rule of their own: a tick is a body save, merged line by line with the other devices' saves. What must hold is that
// the tick is not doubled (the item stays ONE line, never a ticked and an open copy) and not lost (an item some accepted save
// ticked, that nobody un-ticked, is not open in the final body unless the server kept the ticked line in a BODY_CONFLICT entry).
const BOX_LINE = /^- \[( |x)\] ([A-Z]\d+)$/;
async function checkCheckboxes(world: World, workspaceId: string, problems: string[], server: Map<string, ServerNote>): Promise<void> {
  const L = (id: string) => world.label(id);
  const where = new Map<string, Array<{ note: string; ticked: boolean }>>();
  for (const id of world.ordinal.keys()) {
    const s = server.get(id);
    if (!s || s.deleted) continue;
    for (const line of splitBody(s.markdown)) {
      const box = BOX_LINE.exec(line);
      if (box) where.set(box[2]!, [...(where.get(box[2]!) ?? []), { note: id, ticked: box[1] === "x" }]);
    }
  }
  const firstKeys = new Set<string>();
  const everTicked = new Set<string>();
  for (const h of world.server.handled) {
    if (h.status >= 300 || !h.idemKey || firstKeys.has(h.idemKey) || !firstKeys.add(h.idemKey) || typeof h.body?.markdown !== "string") continue;
    for (const line of splitBody(h.body.markdown)) { const box = BOX_LINE.exec(line); if (box?.[1] === "x") everTicked.add(box[2]!); }
  }
  for (const [item, copies] of where) {
    if (copies.length > 1) problems.push(`checkbox ${item}: ${copies.length} lines in the final bodies (${copies.map((c) => `${L(c.note)} ${c.ticked ? "ticked" : "open"}`).join(", ")}): a tick was doubled`);
    const [only] = copies;
    if (copies.length !== 1 || only!.ticked || !everTicked.has(item) || world.untickedItems.has(item)) continue;
    if ((await conflictText(workspaceId, only!.note)).includes(`- [x] ${item}`)) continue;
    problems.push(`${L(only!.note)}: checkbox ${item} was ticked by an accepted save and never un-ticked, but it is open in the final body (and no BODY_CONFLICT entry holds the tick)`);
  }
}

// ── Review (modules/review: grade, undo-grade, tomorrow, the card switch) ──
// Server rules (modules/review/service.ts, state.ts): a schedule is the PERSON's own (review_states, one row per card and person, no
// domain event); a grade advances it by one step and keeps the one before for a single undo; "tomorrow" is a hold that leaves the
// schedule alone; a retried request (same Idempotency-Key) lands once. Everything is judged on the requests the server accepted, in
// the order it handled them, with the schedules it answered: the model below keeps, per person and card, the grades not undone.
type Schedule = { reps: number; lapses: number; due: string };
const sameSchedule = (a: Schedule | null, b: Schedule | null) => (a === null || b === null ? a === b : a.reps === b.reps && a.lapses === b.lapses && a.due === b.due);
const showSchedule = (s: Schedule | null) => (s ? `reps ${s.reps}, lapses ${s.lapses}` : "no schedule");
const scheduleOf = (raw: unknown): Schedule | null => {
  const state = raw as Partial<Schedule> | null | undefined;
  return state && typeof state.reps === "number" && typeof state.lapses === "number" && typeof state.due === "string" ? { reps: state.reps, lapses: state.lapses, due: state.due } : null;
};

async function checkReview(world: World, workspaceId: string, problems: string[], checks: Checks): Promise<void> {
  const L = (id: string) => world.label(id);
  const personOf = (client: string) => (world.people ? world.people[world.clients.findIndex((c) => c.name === client)] ?? client : "everyone");
  const firstKeys = new Set<string>();
  const accepted = world.server.handled.filter((h) => h.status < 300 && !!h.idemKey && !firstKeys.has(h.idemKey) && !!firstKeys.add(h.idemKey));

  type Card = { stack: Schedule[]; shown: number[]; undoable: boolean };
  const model = new Map<string, Card>(); // `${person}:${card}`
  const cardSwitch = new Map<string, boolean>(); // note -> the last accepted switch
  for (const h of accepted) {
    const ids = /^\/api\/review\/([0-9a-f-]{36})\/(grade|undo-grade)$/.exec(h.path);
    const sw = /^\/api\/review\/cards\/([0-9a-f-]{36})$/.exec(h.path);
    if (sw) { cardSwitch.set(sw[1]!, h.method === "PUT"); continue; }
    if (!ids) continue;
    const card = ids[1]!;
    const slot = `${personOf(h.client)}:${card}`;
    const m = model.get(slot) ?? { stack: [], shown: [], undoable: false };
    model.set(slot, m);
    const answered = scheduleOf((h.reply as { state?: unknown } | null)?.state);
    const request = `request ${h.seq + 1}, device ${h.client}`;
    if (ids[2] === "grade") {
      if (!answered) { problems.push(`${L(card)}: a grade was accepted but the answer holds no schedule (${request})`); continue; }
      const before = m.stack.at(-1) ?? null;
      if (answered.reps > (before?.reps ?? 0) + 1) problems.push(`${L(card)}: one grade moved reps from ${before?.reps ?? 0} to ${answered.reps} (${request})`);
      if (answered.lapses > (before?.lapses ?? 0) + 1) problems.push(`${L(card)}: one grade moved lapses from ${before?.lapses ?? 0} to ${answered.lapses} (${request})`);
      const shown = world.clients.find((c) => c.name === h.client)?.gradeShown.get(h.idemKey)?.shown ?? -1;
      if (checks.strictGradeOnce && shown >= 0 && m.shown.includes(shown)) {
        problems.push(`${L(card)}: graded from a screen that still showed reps ${shown}, after another grade of the same showing was accepted: the one review counted twice, reps ${before?.reps ?? 0} -> ${answered.reps} (${request})`);
      }
      m.stack.push(answered); m.shown.push(shown); m.undoable = true;
      continue;
    }
    // undo-grade: one step back, only right after a grade
    if (!m.undoable) {
      if (checks.strictUndo && m.stack.length) problems.push(`${L(card)}: an undo right after an undo was accepted and left ${showSchedule(answered)} although the card had earlier reviews (${showSchedule(m.stack.at(-1) ?? null)}) (${request})`);
      m.stack = answered ? [answered] : []; m.shown = []; // follow what the server says from here
      continue;
    }
    const expected = m.stack.length >= 2 ? m.stack.at(-2)! : null;
    if (expected && !answered) problems.push(`${L(card)}: undo deleted the schedule of a card that had earlier reviews (${showSchedule(expected)}) (${request})`);
    else if (!sameSchedule(expected, answered)) problems.push(`${L(card)}: undo left ${showSchedule(answered)} but the grade before it was ${showSchedule(expected)} (${request})`);
    m.stack.pop(); m.shown.pop(); m.undoable = false;
  }

  // The server holds what its last accepted answer said (a retried request applied once, nothing else moved the schedule).
  const cards = [...world.cardsEver, ...[...model.keys()].map((slot) => slot.slice(slot.indexOf(":") + 1))];
  const stored = await q<{ node_id: string; actor_id: string; state: string }>(
    `SELECT node_id::text, actor_id::text, state FROM review_states WHERE workspace_id = $1 AND node_id = ANY($2::uuid[])`, [workspaceId, cards]);
  const held = new Map<string, Schedule | null>(stored.rows.map((r) => {
    let parsed: unknown = null;
    try { parsed = r.state ? JSON.parse(r.state) : null; } catch { /* a state that is not JSON holds no schedule */ }
    return [`${world.people ? r.actor_id : "everyone"}:${r.node_id}`, scheduleOf(parsed)];
  }));
  for (const [slot, m] of model) {
    const want = m.stack.at(-1) ?? null;
    const got = held.get(slot) ?? null;
    if (!sameSchedule(got, want)) problems.push(`${L(slot.slice(slot.indexOf(":") + 1))}: the server holds ${showSchedule(got)} but the accepted grades and undos leave ${showSchedule(want)}`);
  }
  for (const c of world.clients) {
    if (!world.mayRead(c)) continue;
    for (const card of world.cardsEver) {
      if (!c.reviewStates.has(card)) continue;
      const got = c.reviewStates.get(card) ?? null;
      const want = held.get(`${personOf(c.name)}:${card}`) ?? null;
      if (!sameSchedule(got, want)) problems.push(`${L(card)}: device ${c.name} shows ${showSchedule(got)} but the server holds ${showSchedule(want)}`);
    }
  }

  // The card switch is the note's own function reference: the last accepted switch decides (notes that were ever deleted are left out).
  const family = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    for (const todo = [id]; todo.length; ) for (const p of world.parentsEver.get(todo.pop()!) ?? []) if (p && !out.has(p)) { out.add(p); todo.push(p); }
    return out;
  };
  const refs = await q<{ holder_node_id: string }>(
    `SELECT holder_node_id::text FROM function_refs WHERE workspace_id = $1 AND function_id = 'review' AND instance = '' AND holder_node_id = ANY($2::uuid[])`, [workspaceId, [...world.cardsEver]]);
  const isCard = new Set(refs.rows.map((r) => r.holder_node_id));
  for (const [note, on] of cardSwitch) {
    if ([...family(note)].some((id) => world.everDeleted.has(id))) continue;
    if (isCard.has(note) !== on) problems.push(`${L(note)}: the last accepted card switch says "${on ? "is a card" : "is not a card"}" but the server ${isCard.has(note) ? "has" : "has no"} review reference`);
  }
}

// ── Saved views of a tag or a note (function_refs with an instance; lib/data/viewWriter) ──
// Server rules (services/tagViews.ts, noteViews.ts, functionRefs.ts): a view is a reference on its owner; a PATCH merges only the keys it
// sends; a name is unique per owner (a clash is refused); a retried create lands once. Judged on the accepted requests in handled order.
// `layout_config` is changed whole (older clients) or per key (`layout_config_patch`: a value sets the key, null removes it);
// a patch applies to what the server holds when it is handled, so another device's other keys stay.
const VIEW_KEYS = ["name", "filters", "sorts", "group_by", "visible_fields", "layout_config"] as const;
type ViewShape = Record<(typeof VIEW_KEYS)[number], unknown>;
const viewShape = (v: Record<string, unknown>): ViewShape => ({ name: v.name, filters: v.filters ?? [], sorts: v.sorts ?? [], group_by: v.group_by ?? null, visible_fields: v.visible_fields ?? [], layout_config: v.layout_config ?? {} });
/** The `layout_config` after a per-key patch (services/functionRefs.ts patchView). */
const withLayoutPatch = (config: unknown, patch: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...(config as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = value; }
  return next;
};
/** JSON with the keys of every object sorted: the server stores settings as jsonb, which does not keep the order they were sent in. */
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const sameView = (a: ViewShape, b: ViewShape) => VIEW_KEYS.every((k) => canonical(a[k]) === canonical(b[k]));

async function checkViews(world: World, workspaceId: string, problems: string[]): Promise<void> {
  if (!world.viewOwners.size) return;
  const L = (id: string) => world.label(id);
  const nameOf = (slot: string) => (slot.startsWith("tag:") ? `tag ${world.tagIds.indexOf(slot.slice(4))}` : L(slot.slice(5)));
  const family = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    for (const todo = [id]; todo.length; ) for (const p of world.parentsEver.get(todo.pop()!) ?? []) if (p && !out.has(p)) { out.add(p); todo.push(p); }
    return out;
  };
  // A deleted note takes its views out of reach; only owners that were never deleted are judged.
  const owners = [...world.viewOwners].filter(([, o]) => o.kind === "tag" || ![...family(o.id)].some((id) => world.everDeleted.has(id)));
  const rows = await q<{ holder: string; id: string; layout: string; config: Record<string, unknown> }>(
    `SELECT holder_node_id::text AS holder, instance AS id, function_id AS layout, config FROM function_refs
      WHERE workspace_id = $1 AND instance <> '' AND holder_node_id = ANY($2::uuid[])`, [workspaceId, owners.map(([, o]) => o.id)]);
  const stored = new Map<string, Map<string, ViewShape>>(); // slot -> view id -> settings
  for (const [slot, o] of owners) stored.set(slot, new Map(rows.rows.filter((r) => r.holder === o.id).map((r) => [r.id, viewShape(r.config)])));

  // The accepted creates, changes and deletes, in the order the server handled them.
  const firstKeys = new Set<string>();
  const expected = new Map<string, Map<string, ViewShape>>(owners.map(([slot]) => [slot, new Map()]));
  for (const h of world.server.handled) {
    const at = /^\/api\/(tags|nodes)\/([0-9a-f-]{36})\/views(?:\/([0-9a-f-]{36}))?$/.exec(h.path);
    if (!at || h.status >= 300 || !h.idemKey || firstKeys.has(h.idemKey) || !firstKeys.add(h.idemKey)) continue;
    const views = expected.get(`${at[1] === "tags" ? "tag" : "node"}:${at[2]}`);
    if (!views) continue;
    if (h.method === "POST") views.set(String((h.reply as { id?: string }).id), viewShape(h.body ?? {}));
    else if (h.method === "DELETE") views.delete(at[3]!);
    else if (h.method === "PATCH") {
      const view = views.get(at[3]!);
      if (!view) { problems.push(`${nameOf(`${at[1] === "tags" ? "tag" : "node"}:${at[2]}`)}: a change to a saved view the accepted requests never created (request ${h.seq + 1})`); continue; }
      for (const k of VIEW_KEYS) if (h.body && k in h.body) view[k] = h.body[k];
      if (h.body && "layout_config_patch" in h.body) view.layout_config = withLayoutPatch(view.layout_config, h.body.layout_config_patch as Record<string, unknown>);
    }
  }
  for (const [slot, views] of expected) {
    const got = stored.get(slot)!;
    for (const id of new Set([...views.keys(), ...got.keys()])) {
      const want = views.get(id), have = got.get(id);
      if (!want || !have) problems.push(`${nameOf(slot)}: saved view ${want ? "is missing on the server" : "is on the server but no accepted request left it"} (${JSON.stringify((want ?? have)!.name)})`);
      else if (!sameView(want, have)) problems.push(`${nameOf(slot)}: saved view ${JSON.stringify(have.name)} is ${JSON.stringify(have)} on the server but the accepted changes say ${JSON.stringify(want)}`);
    }
  }

  // Every device that opened an owner's view settings shows what the server stores once it reads them again.
  for (const c of world.clients) {
    for (const [slot, list] of c.viewLists) {
      const got = stored.get(slot);
      if (!got || !world.mayRead(c)) continue;
      if (c.viewsOf(owners.find(([s]) => s === slot)![1]).length !== list.length) problems.push(`device ${c.name}: queued view changes remain on ${nameOf(slot)}`);
      const ids = new Set([...list.map((v) => v.id), ...got.keys()]);
      for (const id of ids) {
        const have = list.find((v) => v.id === id);
        const want = got.get(id);
        if (!have || !want) problems.push(`${nameOf(slot)}: device ${c.name} ${have ? "shows a saved view the server does not have" : "does not show a saved view the server has"} (${JSON.stringify((have?.name ?? want?.name))})`);
        else if (!sameView(viewShape(have), want)) problems.push(`${nameOf(slot)}: device ${c.name} shows saved view ${JSON.stringify(viewShape(have))} but the server has ${JSON.stringify(want)}`);
      }
    }
  }
}

// ── Graph positions (node_positions, surface 'graph') ────────────────────
// The server's rule (routes/nodes.ts PUT /:id/position, services/boardStore.ts setNodePosition):
// a plain upsert, last request handled wins, no domain event ("a drag must not spam the log"), and
// no sync-delta channel: other devices see it when they replace `graph_positions` from
// GET /api/bootstrap?nodes=none. So convergence is judged after that refresh, and a position is
// listed only while its note is live (readPositionsForSurface).
async function checkPositions(world: World, workspaceId: string, problems: string[], mine: string[]): Promise<void> {
  const L = (id: string) => world.label(id);
  const rows = await q<{ node_id: string; x: number; y: number; live: boolean }>(
    `SELECT np.node_id::text, np.x, np.y, (n.deleted_at IS NULL) AS live FROM node_positions np JOIN content_nodes n ON n.id = np.node_id
      WHERE np.workspace_id = $1 AND np.surface = 'graph' AND np.node_id = ANY($2::uuid[])`, [workspaceId, mine]);
  const server = new Map(rows.rows.map((r) => [r.node_id, r]));

  // Last writer wins: nothing accepted is dropped, nothing else is stored.
  const firstKeys = new Set<string>();
  const last = new Map<string, { x: number; y: number }>();
  for (const h of world.server.handled) {
    if (h.status >= 300 || !h.path.endsWith("/position") || firstKeys.has(h.idemKey) || !firstKeys.add(h.idemKey)) continue;
    last.set(noteIdOf(h.path)!, { x: h.body!.x as number, y: h.body!.y as number });
  }
  for (const id of mine) {
    const s = server.get(id);
    const want = last.get(id);
    if (!want && s) problems.push(`${L(id)}: the server holds a position nobody saved`);
    if (want && (!s || s.x !== want.x || s.y !== want.y)) problems.push(`${L(id)}: the server has ${s ? `(${s.x}, ${s.y})` : "no position"} but the last accepted drag was to (${want.x}, ${want.y})`);
  }

  // Convergence after the reconnect refresh: each device holds the server's position of every live note.
  for (const c of world.clients) {
    for (const id of mine) {
      const s = server.get(id);
      const got = c.positions.get(id);
      const want = s?.live && world.mayRead(c) ? { x: s.x, y: s.y } : undefined;
      if (got?.x !== want?.x || got?.y !== want?.y) problems.push(`${L(id)}: device ${c.name} shows position ${JSON.stringify(got)} but the server has ${JSON.stringify(want)}`);
    }
  }
}

// ── Drawings (ink_data) ──────────────────────────────────────────────────
// The server's rule (services/attributeWrites.ts, @onden/markdown/ink mergeInk): a save that names
// the drawing it was made from (`base_value`) is merged three-way into what is stored — strokes by
// id, erasure as sets of points — instead of overwriting it, so a stroke drawn on either device
// survives and a stroke removed on one stays gone. Only an item both sides changed differently is
// recorded as an ATTRIBUTE_CONFLICT.
async function checkInk(world: World, workspaceId: string, problems: string[], mine: string[]): Promise<void> {
  const L = (id: string) => world.label(id);
  const stored = await q<{ node_id: string; value: string }>(
    `SELECT node_id::text, value FROM node_attributes WHERE workspace_id = $1 AND key = $2 AND node_id = ANY($3::uuid[])`, [workspaceId, INK_ATTR, mine]);
  const server = new Map(stored.rows.map((r) => [r.node_id, r.value]));

  // Convergence.
  for (const c of world.clients) {
    for (const id of mine) {
      if (!c.mirror.has(id) || !world.mayRead(c)) continue;
      const got = c.mirror.get(id)!.attrs?.[INK_ATTR];
      if (got !== server.get(id)) problems.push(`${L(id)}: device ${c.name}'s drawing differs from the server's`);
    }
  }

  // What the accepted saves owe the final drawing.
  const firstKeys = new Set<string>();
  const saves = world.server.handled.filter((h) => h.status < 300 && h.path.endsWith(`/attributes/${INK_ATTR}`) && !firstKeys.has(h.idemKey) && !!firstKeys.add(h.idemKey));
  const points = (iv: number[][] | undefined) => new Set((iv ?? []).flatMap(([a, b]) => Array.from({ length: b! - a! + 1 }, (_, k) => a! + k)));
  type Owed = { added: Set<string>; removed: Set<string>; erased: Map<string, Set<number>> };
  const owed = new Map<string, Owed>();
  for (const h of saves) {
    const id = noteIdOf(h.path)!;
    const value = decodeInk(h.body!.value as string);
    const base = decodeInk(h.body!.base_value as string | undefined);
    if (value.kind !== "page") continue;
    const baseDoc: { strokes: Array<{ id: string }>; erased: Record<string, number[][]> } = base.kind === "page" ? base.doc : { strokes: [], erased: {} };
    const o = owed.get(id) ?? { added: new Set(), removed: new Set(), erased: new Map() };
    const had = new Set(baseDoc.strokes.map((s) => s.id));
    const has = new Set(value.doc.strokes.map((s) => s.id));
    for (const sid of has) if (!had.has(sid)) o.added.add(sid);
    for (const sid of had) if (!has.has(sid)) o.removed.add(sid);
    for (const sid of has) {
      const before = points(baseDoc.erased[sid]);
      for (const p of points(value.doc.erased[sid])) if (!before.has(p)) o.erased.set(sid, (o.erased.get(sid) ?? new Set<number>()).add(p));
    }
    owed.set(id, o);
  }
  for (const [id, o] of owed) {
    const value = server.get(id);
    const final = decodeInk(value);
    if (final.kind !== "page") { problems.push(`${L(id)}: the drawing is gone from the server although saves were accepted`); continue; }
    const ids = new Set(final.doc.strokes.map((s) => s.id));
    const missing = [...o.added].filter((sid) => !o.removed.has(sid) && !ids.has(sid));
    if (missing.length) problems.push(`${L(id)}: strokes ${JSON.stringify(missing)} were saved and never removed, but are not in the final drawing`);
    const back = [...o.removed].filter((sid) => ids.has(sid));
    if (back.length) problems.push(`${L(id)}: strokes ${JSON.stringify(back)} were removed by an accepted save but are back in the final drawing`);
    for (const [sid, pts] of o.erased) {
      if (!ids.has(sid)) continue;
      const kept = points(final.doc.erased[sid]);
      const lost = [...pts].filter((p) => !kept.has(p));
      if (lost.length) problems.push(`${L(id)}: stroke ${sid} was erased at points ${JSON.stringify(lost)} by an accepted save, but they are drawn again`);
    }
  }

  // A conflict the server announced for a drawing is on record.
  const announced = new Set(saves.filter((h) => (h.reply as { conflict?: unknown } | null)?.conflict).map((h) => noteIdOf(h.path)!));
  if (announced.size) {
    const rows = await q<{ target_id: string }>(
      `SELECT target_id FROM domain_events WHERE workspace_id = $1 AND event_type = 'ATTRIBUTE_CONFLICT' AND payload->>'key' = $2 AND target_id = ANY($3::text[])`, [workspaceId, INK_ATTR, [...announced]]);
    const recorded = new Set(rows.rows.map((r) => r.target_id));
    for (const id of announced) if (!recorded.has(id)) problems.push(`${L(id)}: the server announced a drawing conflict but none is recorded`);
  }
}

// ── Members (spaces.md: read = member of the note's space; write needs "edit") ───
// Rules the server documents (routes/spaces.ts: only the owner changes members; spine/spaceAccess.ts:
// "view" reads, "edit" writes; a removed member reads nothing): judged on the order the server handled
// the requests, so a delayed request is judged by when it ARRIVED.
//  - No first-time write from a person is accepted while that person is a view-only member or no member.
//    (A retry of a key accepted earlier is answered "done" without applying anything: allowed.)
//  - A write the server refused is surfaced on the device (its `rejected` list, the recovery entry), never dropped.
// "Nothing a member was allowed to write is lost" is the no-loss check above, which counts accepted writes only.
function checkMembers(world: World, problems: string[]): void {
  if (!world.people) return;
  const people = world.people;
  const L = (id: string) => world.label(id);
  const permission = new Map<string, "edit" | "view" | null>(people.map((id, i) => [id, i === 0 ? "edit" : i === 1 ? "edit" : "view"]));
  const seen = new Set<string>();
  for (const h of world.server.handled) {
    const member = /^\/api\/spaces\/[0-9a-f-]{36}\/members\/([0-9a-f-]{36})$/.exec(h.path)?.[1];
    if (member) {
      if (h.status < 300) permission.set(member, h.method === "DELETE" ? null : ((h.body as { permission?: "edit" | "view" } | null)?.permission ?? "view"));
      continue;
    }
    const first = !seen.has(h.idemKey);
    if (h.status < 300) seen.add(h.idemKey);
    // A person's own review progress (a grade, its undo, "tomorrow") is not a write to the shared note (modules/review/service.ts:
    // personal progress, mutatePersonal): a view-only member may do it. The card switch and saved views are the note's and stay judged.
    if (/^\/api\/review\/[0-9a-f-]{36}\/(grade|undo-grade|tomorrow)$/.test(h.path)) continue;
    // Removing a property that is not there is judged like any other write: the server checks who may remove
    // before it looks for the property (routes/nodes.ts), so a person who may not write is refused either way.
    const who = world.clients.findIndex((c) => c.name === h.client);
    const person = people[who];
    if (first && h.status < 300 && person && permission.get(person) !== "edit") {
      problems.push(`device ${h.client}'s person was ${permission.get(person) ?? "not a member"} when the server accepted ${h.method} ${h.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => L(id))} (request ${h.seq + 1})`);
    }
  }
  const refused = new Map<string, number>(); // client+key -> last status
  for (const h of world.server.handled) if (!h.replyLost && !h.path.startsWith("/api/spaces/")) refused.set(`${h.client}:${h.idemKey}`, h.status);
  for (const c of world.clients) {
    for (const [key, status] of refused) {
      if (!key.startsWith(`${c.name}:`) || status < 400 || !key.slice(c.name.length + 1)) continue;
      if (!c.rejected.some((r) => r.write.idemKey === key.slice(c.name.length + 1))) problems.push(`device ${c.name}: a refused write (${status}) is not in its recovery list, it was dropped silently`);
    }
  }
}

// ── Order ────────────────────────────────────────────────────────────────
// What the real client guarantees (frontend lib/data/writeQueue.ts: `serialized`, `drain`; "send a newer edit ahead of an
// older queued edit and then replay the old value" is the bug it prevents): one device's writes leave in the order it made
// them, and the next one waits until the head is acknowledged or refused. So a write's FIRST arrival at the server follows
// the device's own order, however late or reordered other devices' requests are; a delayed original that arrives after its
// retry is only a repeat of a key. The simulator must not break this itself, and the server must not let a repeat act twice.
function checkDeviceOrder(world: World, problems: string[]): void {
  for (const c of world.clients) {
    const rank = new Map(c.submitted.map((key, i) => [key, i]));
    const firstArrival: string[] = [];
    for (const h of world.server.handled) {
      if (h.client === c.name && rank.has(h.idemKey) && !firstArrival.includes(h.idemKey)) firstArrival.push(h.idemKey);
    }
    for (let i = 1; i < firstArrival.length; i++) {
      if (rank.get(firstArrival[i]!)! < rank.get(firstArrival[i - 1]!)!) {
        problems.push(`device ${c.name}: its write #${rank.get(firstArrival[i]!)! + 1} reached the server before its older write #${rank.get(firstArrival[i - 1]!)! + 1} (the queue sends in order)`);
        break;
      }
    }
  }
}

// ── Board cards (node_positions, surface = the board's id) ───────────────
// The server's rule (routes/boards.ts, services/boardWrites.ts applyBoardChanges): a PATCH is a CHANGE — the cards it names
// are upserted (only the fields it names change, per field the last request handled wins; null clears a field; a card
// that is not stored needs x and y to be created) or removed; cards it does not name are left alone; one
// audited mutate(), so a retry of the same Idempotency-Key is acknowledged and not applied again (the same hazard as a
// retried graph drag, which overwrote a newer one until PUT /position claimed its key). A layout is not in the sync
// delta: a device shows what GET /api/boards/:id answered when it opened the board, plus its own changes.
async function checkBoards(world: World, workspaceId: string, problems: string[], mine: string[]): Promise<void> {
  const L = (id: string) => world.label(id);
  const boards = [...world.boardOrdinal.keys()];
  if (!boards.length) return;
  const rows = await q<{ surface: string; node_id: string; x: number; y: number; width: number | null; height: number | null; color: string | null; folded: boolean; live: boolean }>(
    `SELECT np.surface, np.node_id::text, np.x, np.y, np.width, np.height, np.color, np.folded, (n.deleted_at IS NULL) AS live
       FROM node_positions np JOIN content_nodes n ON n.id = np.node_id
      WHERE np.workspace_id = $1 AND np.surface = ANY($2::text[]) AND np.node_id = ANY($3::uuid[])`, [workspaceId, boards, mine]);
  const server = new Map(rows.rows.map((r) => [`${r.surface}:${r.node_id}`, r]));
  const shape = (c: { x: number; y: number; width?: number | null; height?: number | null; color?: string | null; folded?: boolean }) =>
    JSON.stringify([c.x, c.y, c.width ?? null, c.height ?? null, c.color ?? null, !!c.folded]);

  // The last accepted change of each card wins; a card nobody placed is not stored.
  const firstKeys = new Set<string>();
  type Fields = { x: number; y: number; width?: number | null; height?: number | null; color?: string | null; folded?: boolean };
  const expected = new Map<string, Fields | null>(); // slot -> card fields, null = removed / never placed
  for (const h of world.server.handled) {
    const board = /^\/api\/boards\/([0-9a-f-]{36})$/.exec(h.path)?.[1];
    if (!board || h.method !== "PATCH" || h.status >= 300 || firstKeys.has(h.idemKey) || !firstKeys.add(h.idemKey)) continue;
    const cards = (h.body as { cards?: { upsert?: Array<{ nodeId: string } & Record<string, never>>; remove?: string[] } }).cards ?? {};
    for (const id of cards.remove ?? []) expected.set(`${board}:${id}`, null);
    for (const card of cards.upsert ?? []) {
      const slot = `${board}:${card.nodeId}`;
      const old = expected.get(slot);
      const patch = card as Partial<Fields>;
      if (!old && (patch.x === undefined || patch.y === undefined)) continue;
      const next: Record<string, unknown> = { ...(old ?? {}) };
      for (const [key, value] of Object.entries(card)) if (key !== "nodeId" && value !== undefined) next[key] = value;
      expected.set(slot, next as Fields);
    }
  }
  for (const board of boards) {
    for (const id of mine) {
      const slot = `${board}:${id}`;
      const s = server.get(slot);
      const fields = expected.get(slot);
      const want = fields ? shape(fields) : null;
      const got = s ? shape(s) : null;
      if (got !== want) problems.push(`${L(board)}'s board: the card of ${L(id)} is ${got ?? "absent"} on the server but the last accepted change says ${want ?? "absent"}`);
    }
  }

  // After reopening the board, a device shows what the server lists: the live notes' cards, nothing for a person who may not read.
  for (const c of world.clients) {
    for (const board of boards) {
      const layout = c.layouts.get(board);
      if (!layout) continue;
      for (const id of mine) {
        const s = server.get(`${board}:${id}`);
        const want = s?.live && world.mayRead(c) ? shape(s) : null;
        const have = layout.get(id);
        const got = have ? shape(have) : null;
        if (got !== want) problems.push(`${L(board)}'s board: device ${c.name} shows the card of ${L(id)} as ${got ?? "absent"} but the server has ${want ?? "absent"}`);
      }
    }
  }
}
