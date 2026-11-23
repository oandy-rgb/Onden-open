// The link index rows a batched relinkTarget read once (services/wikilinkEdges.ts), looked up per batch of targets.
// A row names a target when one of its link keys equals one of the target's keys (`lc`: title, node reference, aliases, lower-cased in NFC, as SQL
// computed them) or its slugs hold the target's slug: the `&&` condition of wikilinkEdges.indexRowsNaming, on strings already normalized by the
// SQL that wrote them, so it compares strings exactly and normalizes nothing here.
// The work is in proportion to the rows plus the targets (each row's keys go into one map once; a batch looks its own keys up): comparing every row
// with every batch grew with the square of a change bundle (review of PR #1941, round 3; linkIndexLookup.test.ts counts it).

/** One row of note_link_index, as indexRowsNaming reads it. */
export type LinkIndexRow = { note_id: string; link_lc: readonly string[]; link_slug: readonly string[] };

/** The keys a target is named by: what relinkTarget's target query computes. */
type NamedTarget = { lc: readonly string[]; slug: string };

/** `notesNaming(targets)`: the notes whose row names one of `targets`, each once (in no particular order: relinkTarget's candidate query takes a set). */
export function linkIndexLookup(rows: readonly LinkIndexRow[]): { notesNaming: (targets: readonly NamedTarget[]) => string[] } {
  const byLc = new Map<string, string[]>();
  const bySlug = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, note: string) => {
    const notes = map.get(key);
    if (notes) notes.push(note);
    else map.set(key, [note]);
  };
  for (const row of rows) {
    for (const key of row.link_lc) add(byLc, key, row.note_id);
    for (const key of row.link_slug) add(bySlug, key, row.note_id);
  }
  return {
    notesNaming(targets) {
      const notes = new Set<string>();
      for (const t of targets) {
        for (const key of t.lc) for (const note of byLc.get(key) ?? []) notes.add(note);
        for (const note of bySlug.get(t.slug) ?? []) notes.add(note);
      }
      return [...notes];
    },
  };
}
