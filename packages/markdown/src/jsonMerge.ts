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
