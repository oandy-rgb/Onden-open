// The INBOX of a change bundle taken in bounded segments (docs/architecture/proposals/own-node-transport-2026-11-22.md §2.10, batch 6; migration 228 `sync_inbox`,
// node-local). This file is the inbox's rows and the plan; the steps that take a bundle are spine/stampedImport.ts `receiveChangeBundle` and `resumeChangeBundles`.
//
//   pages ──(one short transaction each)──▶ sync_inbox 'page' rows
//         ──(all pages in, the bundle's checks pass, every segment's rows pass the checks)──▶ 'segment' rows + header 'planned'
//         ──(one transaction per segment, under the event lock: merge the segment, remove its row)──▶ … ──▶ finishing step: `have` moves, the clock follows, inbox empty
//
// WHY: one transaction for a whole bundle held the event lock for 95 s for 5,000 notes. Here no transaction holds more than one page, one segment, or the header and
// O(origins) rows of sync_origins (the finishing step); a segment is at most SEGMENT_LIMITS rows and bytes, or ONE group when a group is larger (below).
// What is bounded is the transaction: the plan holds the bundle in memory, as taking it in one piece did. A group larger than the limit is a segment of its own; what a
// group can be: one row and the rows keyed by it or going with it (a note, its anchors unit, anchors and paragraph rows: bounded by what one note may hold); the notes
// that hand one slug over (or a moved note and the notes holding a suffixed form of its slug); a loop of moves (its notes). A row whose cost follows what this node holds,
// not the bundle: a note moved with its subtree, about 10 statements a note under it (stampedInboxScale.integration.test.ts asserts at most 11).
//
// WHILE THE INBOX IS NOT EMPTY this node takes no other bundle and reads none for anyone (`peer_busy`): it may hold stamps beyond its `have`, and a bundle it read
// would say so. The time is bounded by taking what is already here: nothing waits for the sender.
//
// THE PLAN (planWithLeans, pure). A segment is made of whole GROUPS, a group being items that must be taken in one transaction:
//   - the items of one row (its row item and the tombstones of its JSON keys: storeMergedRows merges a row from all of them at once), and the rows keyed by one note
//     (the note and its note_anchor_places row);
//   - a row that goes with its note (an anchor, a paragraph row: RowSource.goesWithNote) and that note: the note's anchors unit and its rows are checked against each
//     other when the transaction commits;
//   - notes that hand a slug to each other or want the same one: the slug a note of the bundle arrives with, the slug this node holds of it, and, when the bundle
//     moves, trashes or removes it (movesNote), the slugs of the notes under it here (they can change space with it) are names; notes sharing one are one group.
//     So every slug decision of the bundle is made inside one segment, by the same rule as in one piece (spine/noteSlugs.ts settleSlugs), on the same notes. A slug with the suffix a note that gives way takes
//     (`foo-2`, `foo-<id8>`) is tied to `foo` when some note has `foo`: the free one a note takes depends on which of those the others hold;
//   - a tag a block save made and the paragraph's membership made by the same write (the tag's mark is derived from the two together);
//   - groups that name each other (a loop of moves).
// Everything else an item names is ORDER, not a group: a uuid anywhere in an item (a value, a stamp's kept value, a head, a `meta.from`) that is the whole key of an
// item of the bundle, or a text that is (an anchor id), puts that item's group in the same segment or an earlier one. So a child comes after its parent, an attribute
// or a membership after its note, every note after its space and its tag; and a subtree of new notes, a space with thousands of notes, a tag on thousands of notes are
// not one transaction. A part of a composite key is what the row points at, not a row (a membership's tag); a row this node holds and the bundle does not carry names
// nothing (it is here before and after). Groups are placed in that order, the one whose first item comes first in the bundle first, packed up to SEGMENT_LIMITS.
import { UUID_SOURCE, isUuid, linkNameKey, linkSlug, wikilinkBodies, wikilinkNames, wikilinkTarget } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { assertAuthority } from "./authority.js";
import { bundleRefused } from "./bundleRefusal.js";
import { snapshotRows, type BundleItem, type ChangeBundle, type ChangeBundlePage } from "./snapshotSql.js";
import { UNIT_SOURCES, jsonSourceOf } from "./stampedMerge/index.js";
import type { ClockReading } from "./stamps.js";

/** The most rows (bundle items) and bytes (of their JSON) one segment takes, unless one group is larger: that group is a segment of its own. */
export type SegmentLimits = { rows: number; bytes: number };
/** 100 rows: on PGlite a received note with what is derived from it (batch 4a) costs about 17 ms (a segment of 150 new notes took 2.1 to 2.9 s; an attribute or a
 *  membership costs less), so a segment holds the event lock for about 2 s at most, and a save waits at most that long (PGlite gives up after 10 s). Measured in
 *  stampedInboxScale.integration.test.ts. */
const SEGMENT_LIMITS: SegmentLimits = { rows: 100, bytes: 1024 * 1024 };

/** A bundle's header without its items: what every page says. */
type BundleHeader = Omit<ChangeBundle, "items">;
/** The header row of the inbox. `receiving`: pages are coming in, nothing is taken. `planned`: the segments are written, each is taken and removed.
 *  `bytes`: of the pages so far. `plan`: the token of the runner that is planning (a second runner's writes are refused: spine/stampedImport.ts planInbox).
 *  `node`: this node's id when it was planned (a database restored under a new id gives the inbox up). `attempts`/`failure`: segments that failed without a refusal. */
type InboxHeader = { bundle: BundleHeader; state: "receiving" | "planned"; segments: number; highest: ClockReading | null; bytes?: number; plan?: string; node?: string; attempts?: number; failure?: string };

/** The most bytes one page and one bundle may hold in the inbox (a page a sender reads is at most 4 MB: spine/stampedBundle.ts PAGE_BYTES). Larger is `bundle_too_large`,
 *  before anything of it is kept. The routes of the transport (batch 9) admit the sender and bound the request before a page reaches this. */
const INBOX_LIMITS = { pageBytes: 8 * 1024 * 1024, bundleBytes: 512 * 1024 * 1024 } as const;

const headerOf = (page: ChangeBundlePage): BundleHeader => { const { page: _p, items: _i, ...h } = page; return h; };

/** Refuses with `peer_busy` while a bundle is in this workspace's inbox (in any state): nothing is taken or read until it is taken whole (or given up). */
export async function assertInboxEmpty(workspaceId: string): Promise<void> {
  if ((await snapshotRows(`SELECT 1 FROM sync_inbox WHERE workspace_id = $1 AND kind = 'header'`, [workspaceId])).rows.length > 0) {
    throw bundleRefused("peer_busy", "this node is still taking another bundle; offer this one again once it is done", 409);
  }
}

/** The inbox's header, locked for the caller's transaction (FOR UPDATE: two runners of one inbox take turns), or null when the inbox is empty. */
export async function lockInboxHeader(workspaceId: string): Promise<InboxHeader | null> {
  return (await snapshotRows<{ content: InboxHeader }>(`SELECT content FROM sync_inbox WHERE workspace_id = $1 AND kind = 'header' FOR UPDATE`, [workspaceId])).rows[0]?.content ?? null;
}

/**
 * One page into the inbox, in the caller's transaction. The first page of a bundle writes the header; a page of another bundle while one is here is `peer_busy`
 * (nothing written); the same page again with the same content is a no-op, with other content `bundle_pages_differ`.
 */
export async function putInboxPage(workspaceId: string, page: ChangeBundlePage): Promise<void> {
  const header = headerOf(page);
  const fresh: InboxHeader = { bundle: header, state: "receiving", segments: 0, highest: null };
  await snapshotRows(`INSERT INTO sync_inbox (workspace_id, kind, n, content) VALUES ($1, 'header', 0, $2::jsonb) ON CONFLICT DO NOTHING`, [workspaceId, JSON.stringify(fresh)]);
  // compared as jsonb (the column does not keep the order of an object's keys)
  const held = (await snapshotRows<{ same: boolean }>(
    `SELECT content->>'state' = 'receiving' AND content->'bundle' = $2::jsonb AS same FROM sync_inbox WHERE workspace_id = $1 AND kind = 'header' FOR UPDATE`, [workspaceId, JSON.stringify(header)])).rows[0]!;
  if (!held.same) {
    throw bundleRefused("peer_busy", "this node is still taking another bundle; offer this one again once it is done", 409);
  }
  if (!Number.isInteger(page.page) || page.page < 1) throw bundleRefused("bundle_pages_differ", "a page number is missing or twice", 422);
  const items = JSON.stringify(page.items);
  const bytes = Buffer.byteLength(items, "utf8");
  if (bytes > INBOX_LIMITS.pageBytes) throw bundleRefused("bundle_too_large", "a page of the bundle is larger than this node takes", 422);
  const put = await snapshotRows(`INSERT INTO sync_inbox (workspace_id, kind, n, content) VALUES ($1, 'page', $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING 1`, [workspaceId, page.page, items]);
  if (put.rows.length > 0) {
    const total = (await snapshotRows<{ b: string }>(
      `UPDATE sync_inbox SET content = jsonb_set(content, '{bytes}', to_jsonb(COALESCE((content->>'bytes')::bigint, 0) + $2)) WHERE workspace_id = $1 AND kind = 'header' RETURNING content->>'bytes' AS b`, [workspaceId, bytes])).rows[0]!.b;
    if (Number(total) > INBOX_LIMITS.bundleBytes) throw bundleRefused("bundle_too_large", "the bundle is larger than this node takes in one inbox", 422);
  } else {
    const same = (await snapshotRows<{ same: boolean }>(`SELECT content = $3::jsonb AS same FROM sync_inbox WHERE workspace_id = $1 AND kind = 'page' AND n = $2`, [workspaceId, page.page, items])).rows[0]?.same;
    if (!same) throw bundleRefused("bundle_pages_differ", "a page arrived twice with other content", 422);
  }
}

/** The numbers of the inbox's rows of one kind, in order. */
export async function inboxRowNumbers(workspaceId: string, kind: "page" | "segment"): Promise<number[]> {
  return (await snapshotRows<{ n: number }>(`SELECT n FROM sync_inbox WHERE workspace_id = $1 AND kind = $2 ORDER BY n`, [workspaceId, kind])).rows.map((r) => r.n);
}

/** A page of the inbox as it arrived, with the header. */
export async function readInboxPage(workspaceId: string, header: BundleHeader, n: number): Promise<ChangeBundlePage> {
  const items = (await snapshotRows<{ content: BundleItem[] }>(`SELECT content FROM sync_inbox WHERE workspace_id = $1 AND kind = 'page' AND n = $2`, [workspaceId, n])).rows[0]!.content;
  return { ...header, page: n, items };
}

/** The first segment still to take, or null. */
export async function firstInboxSegment(workspaceId: string): Promise<{ n: number; items: BundleItem[] } | null> {
  const r = (await snapshotRows<{ n: number; content: BundleItem[] }>(`SELECT n, content FROM sync_inbox WHERE workspace_id = $1 AND kind = 'segment' ORDER BY n LIMIT 1`, [workspaceId])).rows[0];
  return r ? { n: r.n, items: r.content } : null;
}

export async function writeInboxSegment(workspaceId: string, n: number, items: readonly BundleItem[]): Promise<void> {
  await snapshotRows(`INSERT INTO sync_inbox (workspace_id, kind, n, content) VALUES ($1, 'segment', $2, $3::jsonb) ON CONFLICT (workspace_id, kind, n) DO UPDATE SET content = EXCLUDED.content`, [workspaceId, n, JSON.stringify(items)]);
}

export async function writeInboxHeader(workspaceId: string, header: InboxHeader): Promise<void> {
  await snapshotRows(`UPDATE sync_inbox SET content = $2::jsonb WHERE workspace_id = $1 AND kind = 'header'`, [workspaceId, JSON.stringify(header)]);
}

/** Rows of the inbox gone: one page or segment (`only` with `n`), every segment (`only` without: a plan written again), or every row of it (the inbox given up or
 *  done; an outcome of an earlier bundle too). Only the inbox's own system job (spine/systemJobs.ts `change-bundle-inbox`) may: a bundle comes from a node, not a
 *  request, and nothing brings these rows back, so a person's or a session's actor is refused. */
export async function clearInbox(actor: ActorCtx, workspaceId: string, only?: { kind: "page" | "segment"; n?: number }): Promise<void> {
  await assertAuthority(actor, { kind: "system" });
  if (only?.n !== undefined) await snapshotRows(`DELETE FROM sync_inbox WHERE workspace_id = $1 AND kind = $2 AND n = $3`, [workspaceId, only.kind, only.n]);
  else if (only) await snapshotRows(`DELETE FROM sync_inbox WHERE workspace_id = $1 AND kind = $2`, [workspaceId, only.kind]);
  else await snapshotRows(`DELETE FROM sync_inbox WHERE workspace_id = $1`, [workspaceId]);
}

/** A bundle this node gave up on, kept for the person (a later batch's screen shows `sentence`): written in place of the inbox, after it was cleared. */
export async function writeInboxOutcome(workspaceId: string, outcome: { code: string; sentence: string; at: string }): Promise<void> {
  await snapshotRows(`INSERT INTO sync_inbox (workspace_id, kind, n, content) VALUES ($1, 'outcome', 0, $2::jsonb) ON CONFLICT (workspace_id, kind, n) DO UPDATE SET content = EXCLUDED.content`, [workspaceId, JSON.stringify(outcome)]);
}

/** The workspaces whose inbox holds a bundle (start-up goes on with each). */
export async function workspacesWithInbox(): Promise<string[]> {
  return (await snapshotRows<{ workspace_id: string }>(`SELECT workspace_id::text FROM sync_inbox WHERE kind = 'header' ORDER BY workspace_id`)).rows.map((r) => r.workspace_id);
}

const NOTES = "content_nodes";
const UUID = new RegExp(UUID_SOURCE, "gi");
const UUID_IN = new RegExp(UUID_SOURCE, "i");
/** The tables whose rows go with their note (RowSource.goesWithNote): the column naming that note. Such a row is taken with its note (the note's anchors unit and its
 *  rows are checked against each other when the transaction commits). */
const GOES_WITH_NOTE: ReadonlyMap<string, string> = new Map(UNIT_SOURCES.flatMap((s) => (s.goesWithNote ? [[s.table, s.goesWithNote] as const] : [])));

/** The row an item belongs to: its table (a JSON key's tombstone belongs to the row that holds the column) and its key, as storeMergedRows groups them. */
export function rowOfItem(item: BundleItem): { table: string; key: string } {
  const table = jsonSourceOf(item.table)?.of ?? item.table;
  const key = item.kind === "row" ? String(item.stamps.find((s) => s.label === table)?.rowKey ?? "") : item.stamp.rowKey;
  return { table, key };
}

/** Whether an item can move a note's subtree to another space, here (so the notes under it take their slug again): the note goes for good, or the bundle writes its
 *  parent, its space or its trash state past what this node holds (`held`: the receiver's number for a label and an origin, the bundle's `base`). */
export function movesNote(item: BundleItem, held: (label: string, origin: string) => number): boolean {
  if (rowOfItem(item).table !== NOTES) return false;
  if (item.kind === "tombstone") return item.table === NOTES;
  return item.stamps.some((s) => s.label === NOTES && MOVING_FIELDS.has(s.field) && [s, ...s.heads].some((w) => w.seq > held(s.label, w.origin)));
}
const MOVING_FIELDS = new Set(["parent", "space", "deleted"]);

/** Whether this node does not hold an item's row as the bundle leaves it, in a way a later segment can lean on: the bundle removes the row, makes it (its existence
 *  stamp is past what this node holds), or moves or trashes a note (movesNote). `held` as movesNote's. */
export function changesWhatIsHere(item: BundleItem, held: (label: string, origin: string) => number): boolean {
  if (item.kind === "tombstone") return true;
  if (movesNote(item, held)) return true;
  return item.stamps.some((s) => s.field === "*" && [s, ...s.heads].some((w) => w.seq > held(s.label, w.origin)));
}

/** The slug a slug can be the suffixed form of (spine/noteSlugs.ts: a note that gives way takes `-2`, `-3`… from freeSlug, or `-<first eight of its id>`), or null. */
const slugBase = (slug: string): string | null => /^(.+)-(?:\d+|[0-9a-f]{8})$/i.exec(slug)?.[1] ?? null;

/** Every string an item holds anywhere (values, texts, stamps, heads, meta). */
function stringsOf(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) stringsOf(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) stringsOf(v, out);
  return out;
}

/**
 * The segments a bundle is taken in (see the file's header for the groups and the order). `slugsHere`: what this node holds of each note of the bundle (NoteHere,
 * read by dbRows.ts localSlugsOf). Deterministic: the same bundle and the same slugs give the same segments. Every item is in exactly one
 * segment, in bundle order within it, and no item is in a segment before a row it names.
 */
/** What this node holds of a note of the bundle, for the plan: its slug here, the slugs of the notes under it here (only when the bundle moves it: they can follow it), and
 *  whether the bundle moves, trashes or deletes it (movesNote). */
export type NoteHere = { own: string | null; below: readonly string[]; moves: boolean };

/** The plan, and for each segment whether it LEANS on an earlier one: an item of it names (as ORDER above: a key, an anchor id, a `[[link]]`) an item an earlier segment
 *  takes that `changesHere` says this node does not hold yet as the bundle leaves it (changesWhatIsHere: a row the bundle makes or removes, a note it moves or trashes).
 *  A rehearsal of such a segment alone (spine/stampedImport.ts rehearseSegments) runs without that, so its refusal proves nothing; one of a segment that leans on none
 *  is the refusal the segment would meet. A named row the bundle only edits (a title, the workspace's settings) is here already and does not lean. */
export function planWithLeans(items: readonly BundleItem[], slugsHere: ReadonlyMap<string, NoteHere>, limitsOrDefault: SegmentLimits | undefined, changesHere: (item: BundleItem) => boolean): { segments: BundleItem[][]; leans: boolean[] } {
  const limits = limitsOrDefault ?? SEGMENT_LIMITS;
  // 1. GROUPS: what must be in one transaction (union-find over names)
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; let y = x; while (y !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; } return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const rows = items.map(rowOfItem);
  /** the row an item IS, when its key is one uuid (a note, a paragraph row, a pointer; a table keyed by its note, such as note_anchor_places, is that note); the parts of
   *  a composite key (an attribute's note, a membership's tag) are what the row points at, not rows of their own */
  const own = rows.map((r) => (isUuid(r.key) ? r.key.toLowerCase() : null));
  const keyed = new Set(own.filter((u): u is string => u !== null));
  /** the texts that are whole keys (an anchor id) */
  const textKeys = new Map<string, string>();
  rows.forEach((r, i) => { if (!own[i] && r.key && !UUID_IN.test(r.key)) textKeys.set(r.key, `r:${r.table}\u0000${r.key}`); });
  /** what each item names besides itself: the items it comes after */
  const names: string[][] = items.map(() => []);
  items.forEach((item, i) => {
    const { table, key } = rows[i]!;
    union(`#${i}`, `r:${table}\u0000${key}`);
    if (own[i]) union(`#${i}`, `u:${own[i]}`);
    const withNote = GOES_WITH_NOTE.get(table);
    const note = withNote && item.kind === "row" ? item.values?.[withNote] : undefined;
    if (typeof note === "string" && keyed.has(note.toLowerCase())) union(`#${i}`, `u:${note.toLowerCase()}`);
    for (const s of stringsOf(item)) {
      for (const u of s.match(UUID) ?? []) { const l = u.toLowerCase(); if (keyed.has(l) && l !== own[i]) names[i]!.push(`u:${l}`); }
      const t = textKeys.get(s);
      if (t && t !== `r:${table}\u0000${key}`) names[i]!.push(t);
    }
  });
  // A TAG A BLOCK SAVE MADE and the paragraph's membership that write made with it: the mark (`_block_autotag`) is derived when the tag is taken, from the membership
  // stamped by the same write (spine/receivedDerivation.ts tagsMadeWithTheirMark); the membership names the tag, so by order alone it could come a segment later.
  const madeWith = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.kind !== "row" || rows[i]!.table !== "block_node_tags") return;
    const s = it.stamps.find((x) => x.field === "*" && !x.deleted);
    const tag = rows[i]!.key.split("/")[1];
    if (s && tag) madeWith.set(`${s.origin}\u0000${s.seq}\u0000${tag.toLowerCase()}`, i);
  });
  if (madeWith.size) items.forEach((it, i) => {
    if (it.kind !== "row" || rows[i]!.table !== NOTES || !own[i]) return;
    const s = it.stamps.find((x) => x.field === "*" && !x.deleted);
    const j = s ? madeWith.get(`${s.origin}\u0000${s.seq}\u0000${own[i]}`) : undefined;
    if (j !== undefined) union(`#${i}`, `#${j}`);
  });
  // SLUGS (spine/noteSlugs.ts settleSlugs). A note whose claim is a NAME (it was made or renamed) and gives way takes `slug-<id8>`, which no other note's state changes,
  // so notes that only arrive with a slug settle the same in any order. What depends on the order: a slug HANDED OVER (a note of the bundle leaves the slug it holds
  // here: renamed, moved, trashed or deleted for good; when it moves, the notes under it here can change space and slug with it) and the notes that hold or want it; and
  // a PLACED claim (a move, a restore) that gives way, which takes the first free `-2`, `-3`… of its slug. So every handed slug, and for a moved note every suffixed form
  // of its slugs the bundle or this node has, ties the notes that hold or want it into one group.
  const slugNote = items.map((it, i) => {
    if (rows[i]!.table !== NOTES) return null;
    const here = slugsHere.get(rows[i]!.key) ?? { own: null, below: [], moves: false };
    const wanted = it.kind === "row" && typeof it.values?.slug === "string" ? it.values.slug : null;
    return { here, wanted, names: [wanted, here.own, ...here.below].filter((x): x is string => x !== null) };
  });
  const allSlugs = new Set(slugNote.flatMap((n) => n?.names ?? []));
  const handed = new Set<string>();
  items.forEach((it, i) => {
    const n = slugNote[i];
    if (!n) return;
    const leaves = n.here.own !== null && (n.here.moves || it.kind === "tombstone" || (n.wanted !== null && n.wanted !== n.here.own));
    if (leaves) handed.add(n.here.own!);
    if (!n.here.moves) return;
    for (const x of n.names) {
      handed.add(x);
      for (const t of allSlugs) if (slugBase(t) === x) handed.add(t);
    }
  });
  items.forEach((_, i) => { for (const x of slugNote[i]?.names ?? []) if (handed.has(x)) union(`#${i}`, `s:${x}`); });
  for (const t of handed) { const base = slugBase(t); if (base !== null && handed.has(base)) union(`s:${t}`, `s:${base}`); }
  // LINKS: a note whose text the bundle brings has its `[[links]]` worked out in its own segment (services/receivedDerivation.ts deriveFromBody), from the notes as
  // they are then: it comes after every note of the bundle a link of it can name (by title or slug, as wikilinkEdges.ts matches), so it sees them as one piece would
  const named = new Map<string, number[]>();
  items.forEach((it, i) => {
    const n = slugNote[i];
    if (!n) return;
    const title = it.kind === "row" && typeof it.values?.title === "string" ? it.values.title : null;
    for (const k of [...(title !== null ? [`n:${linkNameKey(title)}`] : []), ...[n.wanted, n.here.own].filter((x): x is string => x !== null).map((x) => `g:${x}`)]) {
      (named.get(k) ?? named.set(k, []).get(k)!).push(i);
    }
  });
  items.forEach((it, i) => {
    const body = rows[i]!.table === NOTES && it.kind === "row" ? it.texts?.body : undefined;
    if (typeof body !== "string" || !body.includes("[[")) return;
    for (const b of wikilinkBodies(body)) {
      for (const name of wikilinkNames(wikilinkTarget(b).toLowerCase())) {
        for (const j of [...(named.get(`n:${name}`) ?? []), ...(named.get(`g:${linkSlug(name)}`) ?? [])]) if (j !== i) names[i]!.push(`#${j}`);
      }
    }
  });
  // 2. ORDER: a group comes after the groups it names; groups that name each other (a loop of moves) are one group
  let groupOf = items.map((_, i) => find(`#${i}`));
  const edges = () => {
    const out = new Map<string, Set<string>>();
    const groups = new Set(groupOf);
    items.forEach((_, i) => { for (const n of names[i]!) { const to = find(n), from = groupOf[i]!; if (to !== from && groups.has(to)) (out.get(from) ?? out.set(from, new Set()).get(from)!).add(to); } });
    return out;
  };
  for (const scc of loopsOf([...new Set(groupOf)], edges())) for (const g of scc.slice(1)) union(scc[0]!, g);
  groupOf = items.map((_, i) => find(`#${i}`));
  const after = edges();
  const members = new Map<string, number[]>();
  items.forEach((_, i) => (members.get(groupOf[i]!) ?? members.set(groupOf[i]!, []).get(groupOf[i]!)!).push(i));
  // Kahn's order, the group whose first item comes first in the bundle first among those whose rows it names are placed
  const waiting = new Map([...members.keys()].map((g) => [g, after.get(g)?.size ?? 0] as const));
  const before = new Map<string, string[]>();
  for (const [from, tos] of after) for (const to of tos) (before.get(to) ?? before.set(to, []).get(to)!).push(from);
  const ready = new MinHeap<string>((a, b) => members.get(a)![0]! - members.get(b)![0]!);
  for (const [g, n] of waiting) if (n === 0) ready.push(g);
  const ordered: number[][] = [];
  for (let g = ready.pop(); g !== undefined; g = ready.pop()) {
    ordered.push(members.get(g)!);
    for (const next of before.get(g) ?? []) { const n = waiting.get(next)! - 1; waiting.set(next, n); if (n === 0) ready.push(next); }
  }
  // 3. SEGMENTS: groups in that order, each whole, packed up to the limits
  const size = (i: number) => Buffer.byteLength(JSON.stringify(items[i]), "utf8");
  const segments: BundleItem[][] = [];
  const leans: boolean[] = [];
  const segmentOf = new Map<string, number>();
  let current: number[] = [], bytes = 0, leaning = false;
  const flush = () => { if (current.length) { segments.push([...current].sort((a, b) => a - b).map((i) => items[i]!)); leans.push(leaning); } current = []; bytes = 0; leaning = false; };
  for (const g of ordered) {
    const b = g.reduce((n, i) => n + size(i), 0);
    if (current.length && (current.length + g.length > limits.rows || bytes + b > limits.bytes)) flush();
    const group = groupOf[g[0]!]!;
    segmentOf.set(group, segments.length);
    // the groups it names are placed already (Kahn's order): in this segment, or in an earlier one
    for (const to of after.get(group) ?? []) if ((segmentOf.get(to) ?? segments.length) < segments.length && members.get(to)!.some((i) => changesHere(items[i]!))) leaning = true;
    current.push(...g); bytes += b;
    if (current.length >= limits.rows || bytes >= limits.bytes) flush();
  }
  flush();
  return { segments, leans };
}

/** The strongly connected components of a directed graph with more than one node (Tarjan, iterative): the groups that name each other. */
function loopsOf(nodes: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], out: string[][] = [];
  let next = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { v: string; it: Iterator<string> }[] = [];
    const open = (v: string) => { index.set(v, next); low.set(v, next); next++; stack.push(v); on.add(v); work.push({ v, it: (edges.get(v) ?? new Set<string>()).values() }); };
    open(root);
    while (work.length) {
      const top = work.at(-1)!;
      const step = top.it.next();
      if (!step.done) {
        const w = step.value;
        if (!index.has(w)) open(w);
        else if (on.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) { const up = work.at(-1)!.v; low.set(up, Math.min(low.get(up)!, low.get(top.v)!)); }
      if (low.get(top.v) === index.get(top.v)) {
        const scc: string[] = [];
        for (let w = stack.pop()!; ; w = stack.pop()!) { on.delete(w); scc.push(w); if (w === top.v) break; }
        if (scc.length > 1) out.push(scc);
      }
    }
  }
  return out;
}

/** A binary heap: the least first. */
class MinHeap<T> {
  private readonly xs: T[] = [];
  constructor(private readonly less: (a: T, b: T) => number) {}
  push(x: T): void {
    const xs = this.xs;
    xs.push(x);
    for (let i = xs.length - 1; i > 0;) { const p = (i - 1) >> 1; if (this.less(xs[i]!, xs[p]!) >= 0) break; [xs[i], xs[p]] = [xs[p]!, xs[i]!]; i = p; }
  }
  pop(): T | undefined {
    const xs = this.xs;
    if (!xs.length) return undefined;
    const top = xs[0]!, last = xs.pop()!;
    if (xs.length) {
      xs[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < xs.length && this.less(xs[l]!, xs[m]!) < 0) m = l;
        if (r < xs.length && this.less(xs[r]!, xs[m]!) < 0) m = r;
        if (m === i) break;
        [xs[i], xs[m]] = [xs[m]!, xs[i]!]; i = m;
      }
    }
    return top;
  }
}
