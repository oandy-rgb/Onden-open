// What the three-way merges of the stored page formats (ink.ts, pageText.ts, pageImages.ts)
// share: key-order-independent equality of JSON values (an item re-encoded by
// another writer may list its fields in another order) and the merge of id-keyed
// items. Pure, no imports.

export const isJsonRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored JSON object, or null for nothing, unreadable text or any other JSON value. */
export function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (isJsonRecord(a) && isJsonRecord(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    if (keys.length !== Object.keys(b).filter((k) => b[k] !== undefined).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return false;
}

// ── Several saves from one base, merged at once ────────────────────────────
// A replicated value is merged from a SET of heads (saves made from one base):
// the result must depend only on the base and that set, never on the order the
// heads arrived in or how they were grouped (attempts-2026-11-16 §2.3, PR #1783
// review). So these take every head at once — a two-way merge is the same
// function with two heads — and nothing in them depends on the order of
// `sides` except what both changed differently: there the LAST side in the
// order the caller fixed keeps its version and the conflict is reported (ink.ts
// sorts heads by their text first; page_text / page_images pass [stored,
// incoming], so incoming keeps its version as before).

/** Keys of several sequences woven into one, from the set of sequences only.
 *  Repeatedly output the smallest key that no sequence still has an
 *  unoutput key before; when every candidate waits somewhere (a side
 *  reordered what the base had), an order a side kept from the base does not
 *  count, so the side that changed it wins; when sides that changed it
 *  disagree, the key most sides have next, then the smallest. Keys deleted by some side stay in the weave as anchors (they are
 *  still in the base or another side) and only `keep` decides at the end what
 *  is output, so where a key lands does not depend on which other heads were
 *  merged first. O(total length × sequences).
 *  Use: weaveOrder(["a"], [["a", "x"], ["a", "y"]]) → ["a", "x", "y"]. */
export function weaveOrder(base: readonly string[], sides: readonly (readonly string[])[], keep?: ReadonlySet<string>): string[] {
  const seqs = [[...new Set(base)], ...sides.map((s) => [...new Set(s)])];
  const at = seqs.map((seq) => new Map(seq.map((k, n) => [k, n])));
  const ptr = seqs.map(() => 0);
  const done = new Set<string>();
  const out: string[] = [];
  const waitsIn = (k: string, from: number) => {
    for (let q = from; q < seqs.length; q++) { const n = at[q]!.get(k); if (n !== undefined && n > ptr[q]!) return true; }
    return false;
  };
  for (;;) {
    for (let q = 0; q < seqs.length; q++) while (ptr[q]! < seqs[q]!.length && done.has(seqs[q]![ptr[q]!]!)) ptr[q]!++;
    const candidates = [...new Set(seqs.map((seq, q) => seq[ptr[q]!]).filter((k): k is string => k !== undefined))];
    if (candidates.length === 0) break;
    const min = (keys: string[]) => keys.reduce((m, k) => (k < m ? k : m));
    const free = candidates.filter((k) => !waitsIn(k, 0));
    // Held back by a side only where that side's order is its own change: the key it has next is not one the base also has before `k`.
    const heldByChange = (k: string) => seqs.some((seq, q) => {
      if (q === 0) return false;
      const n = at[q]!.get(k), first = seq[ptr[q]!];
      if (n === undefined || n <= ptr[q]! || first === undefined) return false;
      const bf = at[0]!.get(first), bk = at[0]!.get(k);
      return !(bf !== undefined && bk !== undefined && bf < bk);
    });
    const sidesFree = candidates.filter((k) => !heldByChange(k));
    let next: string;
    if (free.length) next = min(free);
    else if (sidesFree.length) next = min(sidesFree);
    else {
      const heads = (k: string) => seqs.slice(1).filter((seq, q) => seq[ptr[q + 1]!] === k).length;
      const most = Math.max(...candidates.map(heads));
      next = min(candidates.filter((k) => heads(k) === most));
    }
    done.add(next);
    if (!keep || keep.has(next)) out.push(next);
  }
  return out;
}

/** `value` with its keys in a fixed order: `template`'s keys first, in its
 *  order, then any other key sorted. Key order inside an object means nothing
 *  to a reader; fixing it keeps the stored bytes of a merge independent of
 *  which head is which. */
export function inMergedKeyOrder<T extends object>(value: T, template: object | undefined): T {
  const own = value as Record<string, unknown>;
  const keys = Object.keys(own).filter((k) => own[k] !== undefined);
  const present = new Set(keys);
  const first = Object.keys(template ?? {}).filter((k) => present.has(k));
  const known = new Set(first);
  const out: Record<string, unknown> = {};
  for (const k of [...first, ...keys.filter((k) => !known.has(k)).sort()]) out[k] = own[k];
  return out as T;
}

/** One of several values that are the same JSON (sameJson), chosen by bytes
 *  only: one that is not the base's bytes (a side rewrote it), the smallest. */
function sameValueBytes<T>(was: T | undefined, values: readonly T[]): T {
  const texts = values.map((v) => JSON.stringify(v));
  const baseText = was === undefined ? undefined : JSON.stringify(was);
  let best = -1;
  for (let n = 0; n < values.length; n++) {
    if (texts[n] === baseText && texts.some((t) => t !== baseText)) continue;
    if (best < 0 || texts[n]! < texts[best]!) best = n;
  }
  return values[best]!;
}

/** What several sides did to one value from `base` (undefined = absent):
 *  the base's when no side changed it; the one changed value when the sides
 *  that changed it agree; otherwise the last changed side's (in `sides`'
 *  order), `conflict` told. `removedVsChanged`: some side removed it (absent)
 *  and another changed it — the changed one is kept (an edit beats a removal)
 *  and that is reported too. Absent sides of an absent base are unchanged. */
export function mergeValues<T>(base: T | undefined, sides: readonly (T | undefined)[], conflict: () => void): T | undefined {
  const changed = sides.filter((v) => !sameJson(v, base));
  if (changed.length === 0) return base === undefined ? undefined : sameValueBytes(base, [base, ...sides.filter((v): v is T => v !== undefined)]);
  const present = changed.filter((v): v is T => v !== undefined);
  if (present.length === 0) return undefined; // only removed
  const last = present[present.length - 1]!;
  const agree = present.every((v) => sameJson(v, last));
  if (!agree || present.length < changed.length) conflict();
  return agree ? sameValueBytes(base, present) : last;
}

/** Items by id from several sides (mergeValues per id: added kept, removed
 *  gone unless another side changed it, changed on several sides differently:
 *  the last side's, `report`ed). Output order: weaveOrder of the base's and
 *  the sides' orders. */
export function mergeItemsById<T extends { id: string }>(
  base: readonly T[], sides: readonly (readonly T[])[], report: (id: string) => void,
): T[] {
  const valid = (items: readonly T[]) => items.filter((item) => isJsonRecord(item) && typeof item.id === "string");
  const byId = (items: readonly T[]) => new Map(valid(items).map((item) => [item.id, item]));
  const b = byId(base), maps = sides.map(byId);
  const kept = new Map<string, T>();
  const ids = new Set([...b.keys(), ...maps.flatMap((m) => [...m.keys()])]);
  for (const id of ids) {
    const value = mergeValues(b.get(id), maps.map((m) => m.get(id)), () => report(id));
    if (value !== undefined) kept.set(id, value);
  }
  const order = (items: readonly T[]) => valid(items).map((item) => item.id);
  return weaveOrder(order(base), sides.map(order), new Set(kept.keys())).map((id) => kept.get(id)!);
}

// ── Id-keyed items per page (page_text boxes, page_images pictures) ─────────
// Both attributes are `{ v, pages: { [pageKey]: { [listKey]: item[] } } }`;
// these are the encode / three-way merge / conflict-revert steps they share,
// `listKey` naming the list ("boxes" or "images"). Decoding stays in each file
// (each repairs its own item shape).

type PagedDoc<T, K extends string> = { v: number; pages: Record<string, { [P in K]: T[] }> };

/** The stored form: pages with no items are left out. */
export function encodePagedItems<T, K extends string>(doc: PagedDoc<T, K>, listKey: K, version: number): string {
  const pages: Record<string, { [P in K]: T[] }> = {};
  for (const [key, page] of Object.entries(doc.pages)) {
    if (page[listKey].length > 0) pages[key] = page;
  }
  return JSON.stringify({ ...doc, v: version, pages });
}

/** mergeItemsById (stored, incoming) page by page; each conflict is reported with the page it is on. */
export function mergePagedItems<T extends { id: string }, K extends string>(
  b: PagedDoc<T, K>, s: PagedDoc<T, K>, i: PagedDoc<T, K>, listKey: K,
): { pages: Record<string, { [P in K]: T[] }>; conflicts: Array<{ pageKey: string; id: string }> } {
  const conflicts: Array<{ pageKey: string; id: string }> = [];
  const pages: Record<string, { [P in K]: T[] }> = {};
  const keys = new Set([...Object.keys(s.pages), ...Object.keys(i.pages)]);
  for (const key of [...keys].sort()) {
    // [stored, incoming]: changed differently on both, incoming's (mergeItemsById keeps the last side's), reported.
    const items = mergeItemsById(
      b.pages[key]?.[listKey] ?? [], [s.pages[key]?.[listKey] ?? [], i.pages[key]?.[listKey] ?? []],
      (id) => conflicts.push({ pageKey: key, id }),
    );
    pages[key] = { ...s.pages[key], ...i.pages[key], [listKey]: items } as { [P in K]: T[] };
  }
  return { pages, conflicts };
}

/** `doc`'s pages with only the conflicting items taken back from `theirs`:
 *  swapped, removed when that side had none, or re-added when only it had it. */
export function revertPagedConflicts<T extends { id: string }, K extends string>(
  doc: PagedDoc<T, K>, theirs: PagedDoc<T, K>, conflicts: readonly { pageKey: string; id: string }[], listKey: K,
): Record<string, { [P in K]: T[] }> {
  const pages = { ...doc.pages };
  for (const { pageKey, id } of conflicts) {
    const items = [...(pages[pageKey]?.[listKey] ?? [])];
    const other = theirs.pages[pageKey]?.[listKey].find((item) => item.id === id);
    const at = items.findIndex((item) => item.id === id);
    if (at < 0) { if (other) items.push(other); }
    else if (other) items[at] = other;
    else items.splice(at, 1);
    pages[pageKey] = { ...pages[pageKey], [listKey]: items } as { [P in K]: T[] };
  }
  return pages;
}
