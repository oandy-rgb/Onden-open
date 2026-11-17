// Two things with one name where there may be only one (tags 4.2, saved views 4.8, public slugs 4.3). All three:
// the one that came first (or was published first) keeps the name, every other one is SHOWN under the next free
// "name (2)" / "name-2" and a notice goes to whoever can sort it out. The answer is a view computed from the merged rows,
// not a write: nothing is renamed in the data, so every node shows the same names and a rename by a person later is an
// ordinary write.
import { tagClashName } from "@onden/markdown/contract";
import { type Stamp, compareStamps } from "../unit.js";

export type NameItem = { id: string; scope: string; name: string; created: Stamp };
export type NameRule = { rank?: (a: NameItem, b: NameItem) => number; format: (name: string, n: number) => string; fold?: (name: string) => string };
export type NameClash = { scope: string; name: string; keeper: string; others: string[] };
export type NameResolution = { shown: Map<string, string>; clashes: NameClash[] };

const byCreated = (a: NameItem, b: NameItem) => compareStamps(a.created, b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resolveNameClashes(items: readonly NameItem[], rule: NameRule): NameResolution {
  const fold = rule.fold ?? ((n: string) => n.normalize("NFC"));
  const rank = (a: NameItem, b: NameItem) => (rule.rank?.(a, b) ?? 0) || byCreated(a, b);
  const sorted = [...items].sort(rank);
  const groups = new Map<string, NameItem[]>();
  for (const it of sorted) { const k = `${it.scope}\u0000${fold(it.name)}`; groups.set(k, [...(groups.get(k) ?? []), it]); }
  const taken = new Set<string>();
  for (const [k] of groups) taken.add(k); // every name a first-of-its-group keeps is not free for a suffixed one
  const shown = new Map<string, string>();
  const clashes: NameClash[] = [];
  for (const [, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [keeper, ...rest] = group as [NameItem, ...NameItem[]];
    if (rest.length === 0) continue;
    clashes.push({ scope: keeper.scope, name: keeper.name, keeper: keeper.id, others: rest.map((r) => r.id) });
  }
  // Suffixes go out in rank order across the whole set, so which "(2)" an item gets does not depend on which group was visited first.
  for (const it of sorted) {
    const k = `${it.scope}\u0000${fold(it.name)}`;
    if (groups.get(k)![0] === it) continue;
    for (let n = 2; ; n++) {
      const candidate = rule.format(it.name, n), key = `${it.scope}\u0000${fold(candidate)}`;
      if (!taken.has(key)) { taken.add(key); shown.set(it.id, candidate); break; }
    }
  }
  return { shown, clashes };
}

/** Tags with the same name under one parent (4.2). The earlier-created keeps `#name`. Soft-deleted tags are left out by the caller: a deleted tag frees its name. */
export const resolveTagNames = (tags: readonly { id: string; parent: string | null; name: string; created: Stamp }[]): NameResolution =>
  resolveNameClashes(tags.map((t) => ({ id: t.id, scope: t.parent ?? "", name: t.name, created: t.created })), { format: tagClashName });

/** Saved views with the same name on one tag or note (4.8). The later one is shown as "name (2)". */
export const resolveViewNames = (views: readonly { id: string; owner: string; name: string; created: Stamp }[]): NameResolution =>
  resolveNameClashes(views.map((v) => ({ id: v.id, scope: v.owner, name: v.name, created: v.created })), { format: (n, k) => `${n} (${k})` });

export type SlugItem = { id: string; slug: string; created: Stamp; published: Stamp | null };
export type SlugResolution = NameResolution & {
  /** A slug that was already public had to change because another public page holds it too (two published with one slug): no rule can keep both URLs. */
  publishedUrlChanged: string[];
};
/** Public slugs (4.3): a published page keeps its URL over an unpublished one; among published, the earlier publication; otherwise the earlier-created. The other ones get "slug-2". */
export function resolveSlugs(items: readonly SlugItem[]): SlugResolution {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rank = (a: NameItem, b: NameItem) => {
    const pa = byId.get(a.id)!.published, pb = byId.get(b.id)!.published;
    if (pa && pb) return compareStamps(pa, pb);
    return pa ? -1 : pb ? 1 : 0;
  };
  const r = resolveNameClashes(items.map((i) => ({ id: i.id, scope: "", name: i.slug, created: i.created })), { rank, format: (n, k) => `${n}-${k}`, fold: (n) => n });
  return { ...r, publishedUrlChanged: [...r.shown.keys()].filter((id) => byId.get(id)!.published !== null).sort() };
}
