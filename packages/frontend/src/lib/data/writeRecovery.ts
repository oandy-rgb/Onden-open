import { PREFS, getPref, prefsAvailable, removePref, setPref } from "../prefs";
import type { OfflineQueueFailedDetail, WriteMethod } from "./writeQueue";
import { onPageHide } from "../pageHide";
import { onAppResume } from "../appResume";
import { randomUUID } from "../uuid";
import { getRejectedWrites, rejectPendingWrite, storeRejectedWrite, dismissRejectedWrite, type RejectedWrite, type PendingWrite } from "../localDb";
import { WriteStorageError, markRecoveryEntryShown } from "./writeErrors";
import { targetIds, targetsEntity, type WriteTarget } from "../pendingWriteTargets";
import { noteSizeProblem } from "@onden/markdown";

const pendingExitProtection = new Set<OfflineQueueFailedDetail>();
let offPageHide: (() => void) | null = null;

/** Protect a started write even while it is waiting for its mirror/resource
 * lane. Only page exit exposes it as unconfirmed recovery; ordinary in-flight
 * writes do not flash the recovery panel. The original key is kept for replay. */
export function protectPendingWriteOnExit(request: OfflineQueueFailedDetail): () => void {
  const snapshot = { ...request };
  pendingExitProtection.add(snapshot);
  if (pendingExitProtection.size === 1 && typeof window !== "undefined") {
    offPageHide = onPageHide(preservePendingOnExit);
  }
  return () => {
    pendingExitProtection.delete(snapshot);
    if (pendingExitProtection.size === 0 && typeof window !== "undefined") {
      offPageHide?.();
      offPageHide = null;
    }
  };
}

function preservePendingOnExit(): void {
  for (const request of pendingExitProtection) rememberUnconfirmedWrite(request);
}

/** One value per page load. pagehide of the old page runs AFTER the new page's time origin, so "older than this page"
 *  cannot be told by the clock: an entry says which page life made it instead. */
const PAGE_LIFE = randomUUID();

/** Whether this page load made the entry (its write may still be on the wire) rather than an earlier one. */
export function madeByThisPage(write: LostWrite): boolean { return write.life === PAGE_LIFE; }

/** True from this page's pagehide (or hidden) until it is shown again. An entry made then is what a LATER page load may
 *  take over (`adoptable`); one made while the page is alive is on its way from a page that may still be open (another
 *  tab, or this one), and nobody else may send it. */
let leaving = false;
if (typeof window !== "undefined" && typeof document !== "undefined") {
  onPageHide(() => { leaving = true; });
  onAppResume(() => { leaving = false; }, ["visible"]);
}

/** Whether a later page load may send the entry itself: it was made on the way out of a page, or by a build that did
 *  not say (then it was made on the way out too). An entry kept while its page was alive (a crash, another open tab's
 *  write, a queue that could not take it) stays in recovery for the person's own retry. */
export function adoptable(write: LostWrite): boolean {
  return !madeByThisPage(write) && (write.life === undefined || write.exited === true);
}

export type LostWrite = {
  id: string;
  /** The page load that made the entry (PAGE_LIFE); absent on entries kept by an older build. */
  life?: string;
  /** Made while that page was going away (see `leaving`). */
  exited?: boolean;
  method: WriteMethod;
  path: string;
  body: string | null;
  idemKey?: string | null;
  /** Human-readable preview pulled out of the body (title/markdown), for the UI. */
  text: string;
  at: number;
  /** A server refusal; never eligible for automatic replay. */
  rejection?: string;
  /** Recovery persistence has not been confirmed. Copy before leaving. */
  unpersisted?: boolean;
  /** What the request acts on, as recorded with the durable row (absent on an
   *  in-memory copy or an older row: read through writeTargets()). */
  targets?: WriteTarget[];
  /** The note text the request carries (a note save), read from `body` once when the
   *  entry is made, so the reload gate compares fields and never parses a body. */
  noteText?: { markdown: string; title?: string };
};

function noteTextOf(body: string | null): LostWrite["noteText"] {
  if (!body) return undefined;
  try {
    const fields: unknown = JSON.parse(body);
    if (!fields || typeof fields !== "object") return undefined;
    const { markdown, title } = fields as { markdown?: unknown; title?: unknown };
    if (typeof markdown !== "string") return undefined;
    return typeof title === "string" ? { markdown, title } : { markdown };
  } catch { return undefined; }
}

// The text the user typed and could lose, pulled out of an opaque write body:
// note title/body, a tag name, a cell value. Anything else in a JSON body
// (ids, types, timestamps) is never shown or copied; a body with none of these
// fields has nothing of the user's in it ("" = no recovery entry).
function previewOf(body: string | null): string {
  if (!body) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return body.trim(); } // not JSON: plain text the user wrote
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const fields = parsed as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0 ? v : null;
  const parts = [fields.markdown, fields.body, fields.content, fields.value]
    .map(text).filter((v): v is string => v !== null);
  const title = text(fields.title)?.trim() ?? text(fields.name)?.trim() ?? "";
  if (title && !parts.some(part => part.trimStart().split(/\r?\n/, 1)[0].trim() === title)) {
    parts.unshift(title);
  }
  // Bodies may expose the same text under more than one transport field.
  return [...new Set(parts.map(part => part.trim()))].join("\n").trim();
}

/** Whether a write carries anything the user typed. Id-only writes (duplicate,
 *  move, delete, reorder) have nothing to recover: one plain message is enough. */
export function hasUserText(body: string | null): boolean {
  return previewOf(body) !== "";
}

// Refusals of the same request on the same target are one problem (a field or cell: the latest value replaces
// the older; a note: when the newer one still holds everything the older
// one did (typing on after a refusal makes a longer copy of the same text)). A create (POST) is a separate intent per
// typed text. When the older one holds a line the newer lacks (the page was reloaded and the same refusal came again
// with less text), hiding it behind the newer entry would lose that text from the panel: it stays its own entry.
const NOTE_SAVE_PATH = /^\/api\/nodes\/[^/]+$/;
function textLines(body: string | null): Set<string> {
  return new Set(previewOf(body).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function newerCoversOlder(newer: RejectedWrite, older: RejectedWrite): boolean {
  if (newer.method !== older.method || newer.path !== older.path || newer.rejection !== older.rejection) return false;
  if (newer.method === "POST") return previewOf(newer.body) === previewOf(older.body);
  // A field or a cell is replaced by its latest value; only a note save is text that accumulates.
  if (!NOTE_SAVE_PATH.test(newer.path)) return true;
  const kept = textLines(newer.body);
  return [...textLines(older.body)].every((line) => kept.has(line));
}

/** `{ noteText }` for a body that carries a note save, else nothing. */
function noteTextField(body: string | null): Pick<LostWrite, "noteText"> {
  const noteText = noteTextOf(body);
  return noteText ? { noteText } : {};
}

function parseStored(raw: string | null): LostWrite[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Entries stored before noteText existed get it from their body.
    return Array.isArray(parsed) ? (parsed as LostWrite[]).map((write) => write.noteText ? write : { ...write, ...noteTextField(write.body) }) : [];
  } catch { return []; }
}

let cached: LostWrite[] = [];
let cachedRaw: string | null | undefined;
const listeners = new Set<() => void>();

function getUnconfirmedWrites(): LostWrite[] {
  // Keep the memory copy when browser storage is unavailable (or the page is
  // not yet bound to an account).
  if (!prefsAvailable(PREFS.lostWrites)) return cached;
  const raw = getPref(PREFS.lostWrites);
  if (cachedRaw === undefined && cached.length) {
    // Writes kept in memory before storage was reachable (e.g. before the
    // page was bound to an account) join the stored ones instead of being
    // replaced by them.
    const stored = parseStored(raw);
    const merged = [...stored, ...cached.filter((write) => !write.idemKey || !stored.some((s) => s.idemKey === write.idemKey))];
    const next = JSON.stringify(merged);
    cached = merged;
    cachedRaw = setPref(PREFS.lostWrites, next) ? next : raw;
    return cached;
  }
  if (raw !== cachedRaw) { cachedRaw = raw; cached = parseStored(raw); }
  return cached;
}

let rejectedRows: RejectedWrite[] = [];
let rejectedEntries: LostWrite[] = [];
let snapshot: LostWrite[] = [];
let snapshotUnconfirmed: LostWrite[] | undefined;
let snapshotRejected: LostWrite[] | undefined;

/** Stable external-store snapshot. Durable refusals live in SQLite; a direct
 * refusal keeps a best-effort exit copy until that persistence is confirmed. */
export function getRecoveryWrites(): LostWrite[] {
  const unconfirmed = getUnconfirmedWrites();
  if (snapshotUnconfirmed !== unconfirmed || snapshotRejected !== rejectedEntries) {
    snapshotUnconfirmed = unconfirmed; snapshotRejected = rejectedEntries;
    snapshot = [...unconfirmed, ...rejectedEntries];
  }
  return snapshot;
}

/** Whether this recovery entry is still there after a page reload: a refused
 *  write kept in the local copy, or an entry browser storage really holds
 *  (the memory-only copy of a failed storage write does not count). */
function survivesReload(write: LostWrite): boolean {
  if (!write.unpersisted && write.id.startsWith("rejected:")) return true;
  if (!prefsAvailable(PREFS.lostWrites)) return false;
  return parseStored(getPref(PREFS.lostWrites)).some((stored) => stored.id === write.id);
}

/** The recovery entry that holds exactly this note text (a refused or
 *  unconfirmed save of it) and will still be there after a reload; null when
 *  the text lives only in memory. `title` is checked only when the request
 *  carried one: a body save leaves an unchanged title out. */
export function recoveryHolding(nodeId: string, text: { markdown: string; title?: string }): LostWrite | null {
  for (const write of getRecoveryWrites()) {
    if (!targetsEntity(write, "node", nodeId) || !survivesReload(write)) continue;
    const held = write.noteText;
    if (!held || held.markdown !== text.markdown) continue;
    if (held.title !== undefined && text.title !== undefined && held.title !== text.title) continue;
    return write;
  }
  return null;
}

// Entry id -> every stored row it stands for (the latest first).
let rejectedGroups = new Map<string, RejectedWrite[]>();

function receiveRejected(rows: RejectedWrite[]): void {
  rejectedRows = rows;
  const groups: RejectedWrite[][] = [];
  for (const row of [...rows].reverse()) {
    const group = groups.find(g => newerCoversOlder(g[0], row));
    if (group) group.push(row); else groups.push([row]);
  }
  rejectedGroups = new Map();
  rejectedEntries = groups.reverse().map(([row, ...older]) => {
    const id = `rejected:${row.id}`;
    rejectedGroups.set(id, [row, ...older]);
    return {
      id, method: row.method as WriteMethod, path: row.path,
      body: row.body, idemKey: row.idem_key, text: previewOf(row.body), at: 0, rejection: row.rejection,
      ...(row.targets ? { targets: row.targets } : {}),
      ...noteTextField(row.body),
    };
  });
  for (const listener of listeners) listener();
}

export async function refreshRecoveryWrites(): Promise<void> {
  try { receiveRejected(await getRejectedWrites()); }
  catch (cause) { throw new WriteStorageError(cause); }
}

/** Called after terminal replay refusal, before any later request is sent.
 * Durability failure leaves the queue row pending and stops the drain. */
export async function preserveRejectedWrite(write: PendingWrite, reason: string): Promise<void> {
  let row: RejectedWrite;
  try { row = await rejectPendingWrite(write, reason); }
  catch (cause) { throw new WriteStorageError(cause); }
  receiveRejected([...rejectedRows.filter(existing => existing.id !== write.id), row]);
}

/** A direct refusal has no queued row. Preserve it outside replay, including
 * while the worker commit is pending. Storage failure leaves a clearly marked
 * best-effort copy and must not change the original server refusal into success. */
export async function preserveDirectRejection(request: OfflineQueueFailedDetail & { idemKey: string }, reason: string, refusal?: unknown): Promise<void> {
  // Nothing the user typed (duplicate, move, delete…): the caller's one error
  // message is the whole outcome, and nothing is left to recover.
  if (!hasUserText(request.body)) return;
  const current = getUnconfirmedWrites();
  const existing = current.find(write => write.idemKey === request.idemKey);
  const entry: LostWrite = {
    method: request.method, path: request.path, body: request.body, idemKey: request.idemKey,
    id: existing?.id ?? randomUUID(), text: previewOf(request.body), at: Date.now(),
    rejection: reason, unpersisted: true, ...noteTextField(request.body),
  };
  persist(existing ? current.map(write => write.id === existing.id ? entry : write) : [...current, entry]);
  // The entry is on screen from here on (even if durable storage then fails).
  markRecoveryEntryShown(refusal);
  // The same refusal of the same text is already kept (the page was reloaded and the same save was refused again):
  // one durable copy is enough, and discarding it must not leave a second one behind.
  if (rejectedRows.some((row) => row.method === request.method && row.path === request.path && row.body === request.body && row.rejection === reason)) {
    confirmRecoveredWrite(request.idemKey);
    return;
  }
  let row: RejectedWrite;
  try { row = await storeRejectedWrite({ method: request.method, path: request.path, body: request.body, idem_key: request.idemKey }, reason); }
  catch (cause) { throw new WriteStorageError(cause); }
  receiveRejected([...rejectedRows.filter(existingRow => existingRow.id !== row.id), row]);
  confirmRecoveredWrite(request.idemKey);
}

function persist(writes: LostWrite[]): void {
  getUnconfirmedWrites();
  cached = writes;
  // Storage unavailable: keep the memory copy and the last observed value.
  const raw = writes.length ? JSON.stringify(writes) : null;
  if (raw === null ? removePref(PREFS.lostWrites) : setPref(PREFS.lostWrites, raw)) cachedRaw = raw;
  for (const listener of listeners) listener();
}

export function subscribeRecovery(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}

/** Synchronous protection before page exit or after a failed queue commit.
 * The same request key is retained until server/queue acknowledgement. */
export function rememberUnconfirmedWrite(detail: OfflineQueueFailedDetail): void {
  const current = getUnconfirmedWrites();
  const existing = detail.idemKey ? current.find((write) => write.idemKey === detail.idemKey) : undefined;
  // A late pagehide from the same in-flight write must not turn a known
  // refusal back into a retryable request.
  if (existing?.rejection || (detail.idemKey && rejectedEntries.some(write => write.idemKey === detail.idemKey))) return;
  const entry: LostWrite = {
    method: detail.method, path: detail.path, body: detail.body, idemKey: detail.idemKey,
    id: existing?.id ?? randomUUID(), life: PAGE_LIFE, ...(leaving || existing?.exited ? { exited: true } : {}),
    text: previewOf(detail.body), at: Date.now(), ...noteTextField(detail.body),
  };
  persist(existing ? current.map((write) => write.id === existing.id ? entry : write) : [...current, entry]);
}

export async function removeRecoveryWrite(id: string): Promise<void> {
  const group = rejectedGroups.get(id);
  if (group) {
    const gone = new Set<number>();
    try { for (const row of group) { await dismissRejectedWrite(row); gone.add(row.id); } }
    catch (cause) { receiveRejected(rejectedRows.filter(row => !gone.has(row.id))); throw new WriteStorageError(cause); }
    receiveRejected(rejectedRows.filter(row => !gone.has(row.id)));
    return;
  }
  persist(getUnconfirmedWrites().filter((write) => write.id !== id));
}

/** A save of this note text was accepted (by the server or the durable queue): a refused copy of the same text is
 *  resolved, not still lost. The text must be identical; the refused title counts as resolved when it is the one
 *  saved now or one the app itself refuses (the person shortened it). Anything else stays for the person to discard.
 *  A failed removal leaves the entry (a copy too many beats one too few) and never changes the save's outcome. */
export async function settleRefusedNoteText(nodeId: string, saved: { markdown: string; title: string }): Promise<void> {
  for (const write of getRecoveryWrites()) {
    const held = write.noteText;
    if (write.rejection === undefined || !held || held.markdown !== saved.markdown || !targetsEntity(write, "node", nodeId)) continue;
    if (held.title !== undefined && held.title !== saved.title && !noteSizeProblem({ title: held.title })) continue;
    try { await removeRecoveryWrite(write.id); } catch { /* stays listed */ }
  }
}

/** The merge base a note save is sent with. The rule (docs/architecture/note-writes.md "沒有被收下的文字不算數"):
 *  text the server did not accept is not text it holds, so it is never a save's three-way-merge base. A request
 *  whose `base_markdown` is the text of a refused save of the same note (held in recovery, which outlives a reload)
 *  goes with that save's own base instead, followed back as far as it leads. Without this the server reads the
 *  refused lines as "deleted by somebody else" and merges them away although nobody else wrote (saveTiming S4), and
 *  the save then looks like it kept that text.
 *  The base comes from many places (the editor's last accepted save, a row the store shows with this device's queued
 *  text laid over it after a reload, an exit save built on the save before it); writeQueue applies this where every
 *  request leaves (sendRecorded and the drain), so all of them take one road. Any other request is returned as is.
 *  `body_change` is left alone: the server trusts it only when it turns the stored body into the new one. */
export function withoutRefusedBase<R extends { method: string; path: string; body: string | null }>(request: R): R {
  if (request.method !== "PATCH" || !request.body) return request;
  const nodeId = targetIds(request, "node").find((id) => targetsEntity(request, "node", id));
  if (!nodeId) return request;
  let fields: Record<string, unknown>;
  try { fields = JSON.parse(request.body) as Record<string, unknown>; } catch { return request; }
  if (!fields || typeof fields !== "object" || typeof fields.base_markdown !== "string") return request;
  const refusedBase = new Map<string, string>();
  for (const write of [...rejectedRows, ...getUnconfirmedWrites().filter((entry) => entry.rejection !== undefined)]) {
    if (write.method !== "PATCH" || !targetsEntity(write, "node", nodeId)) continue;
    const refused = noteTextField(write.body).noteText?.markdown;
    const base = baseOf(write.body);
    if (refused !== undefined && base !== undefined && refused !== base && !refusedBase.has(refused)) refusedBase.set(refused, base);
  }
  let base = fields.base_markdown;
  for (const seen = new Set<string>(); refusedBase.has(base) && !seen.has(base);) { seen.add(base); base = refusedBase.get(base)!; }
  return base === fields.base_markdown ? request : { ...request, body: JSON.stringify({ ...fields, base_markdown: base }) };
}

function baseOf(body: string | null): string | undefined {
  try {
    const base = (JSON.parse(body ?? "null") as { base_markdown?: unknown } | null)?.base_markdown;
    return typeof base === "string" ? base : undefined;
  } catch { return undefined; }
}

export function confirmRecoveredWrite(idemKey: string): void {
  const current = getUnconfirmedWrites();
  if (current.some((write) => write.idemKey === idemKey)) {
    persist(current.filter((write) => write.idemKey !== idemKey));
  }
}

export function setRecoveryWriteKey(id: string, idemKey: string): void {
  persist(getUnconfirmedWrites().map((write) => write.id === id ? { ...write, idemKey } : write));
}
