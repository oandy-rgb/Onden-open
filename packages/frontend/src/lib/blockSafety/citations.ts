import type { BlockCitationRow } from "@onden/contract";
// 「被引用 N 次」: who cites the paragraphs of the open note. The server counts
// (reads.notes.blockCitations, only notes the reader can see); this groups its
// rows by paragraph for the editor's badge, the reading view's badge and the
// list a tap on the number opens.


export type { BlockCitationRow };

/** The citing notes of each paragraph, by the paragraph's `^id`. */
export type BlockCitations = ReadonlyMap<string, readonly BlockCitationRow[]>;

export const NO_CITATIONS: BlockCitations = new Map();

export function groupCitations(rows: readonly BlockCitationRow[]): BlockCitations {
  const byBlock = new Map<string, BlockCitationRow[]>();
  for (const row of rows) {
    const list = byBlock.get(row.block_ref);
    if (list) list.push(row);
    else byBlock.set(row.block_ref, [row]);
  }
  return byBlock;
}

/** How many places cite the paragraph (a note that cites it twice counts twice). */
export const citationCount = (rows: readonly BlockCitationRow[] | undefined): number =>
  rows ? rows.reduce((n, row) => n + row.uses, 0) : 0;
