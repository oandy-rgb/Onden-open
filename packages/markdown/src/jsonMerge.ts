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

/** Three-way merge of id-keyed items. Added on either side: kept. Removed on
 *  one side: removed, unless the other side changed it (then it is kept and
 *  `report`ed). Changed on one side: that side's version. Changed on both:
 *  incoming's, reported. Order: incoming's, then the stored side's additions. */
export function mergeById<T extends { id: string }>(
  base: readonly T[], stored: readonly T[], incoming: readonly T[], report: (id: string) => void,
): T[] {
  const byId = (items: readonly T[]) => new Map(items.filter((item) => isJsonRecord(item) && typeof item.id === "string").map((item) => [item.id, item]));
  const b = byId(base), s = byId(stored), i = byId(incoming);
  const out: T[] = [];
  for (const [id, mine] of i) {
    const theirs = s.get(id);
    const was = b.get(id);
    if (theirs === undefined) {
      if (was === undefined) out.push(mine); // added here
      else if (!sameJson(mine, was)) { out.push(mine); report(id); } // removed there, changed here
      // else removed there, untouched here: stays removed
    } else if (sameJson(mine, theirs) || (was !== undefined && sameJson(theirs, was))) {
      out.push(mine);
    } else if (was !== undefined && sameJson(mine, was)) {
      out.push(theirs); // changed there only
    } else { out.push(mine); report(id); } // changed (or added) differently on both
  }
  for (const [id, theirs] of s) {
    if (i.has(id)) continue;
    const was = b.get(id);
    if (was === undefined) out.push(theirs); // added there
    else if (!sameJson(theirs, was)) { out.push(theirs); report(id); } // removed here, changed there
    // else removed there, untouched here: stays removed
  }
  return out;
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

/** mergeById page by page; each conflict is reported with the page it is on. */
export function mergePagedItems<T extends { id: string }, K extends string>(
  b: PagedDoc<T, K>, s: PagedDoc<T, K>, i: PagedDoc<T, K>, listKey: K,
): { pages: Record<string, { [P in K]: T[] }>; conflicts: Array<{ pageKey: string; id: string }> } {
  const conflicts: Array<{ pageKey: string; id: string }> = [];
  const pages: Record<string, { [P in K]: T[] }> = {};
  const keys = new Set([...Object.keys(s.pages), ...Object.keys(i.pages)]);
  for (const key of [...keys].sort()) {
    const items = mergeById(
      b.pages[key]?.[listKey] ?? [], s.pages[key]?.[listKey] ?? [], i.pages[key]?.[listKey] ?? [],
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
