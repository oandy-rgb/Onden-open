/** Newest-updated first: the one comparator for 「最近」 style lists. A missing
 *  `updated_at` sorts last. ISO timestamps compare correctly as strings. */
export function byUpdatedDesc(a: { updated_at?: string | null }, b: { updated_at?: string | null }): number {
  return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
}

/** Oldest-updated first (a queue): the same order, reversed. */
export function byUpdatedAsc(a: { updated_at?: string | null }, b: { updated_at?: string | null }): number {
  return byUpdatedDesc(b, a);
}
