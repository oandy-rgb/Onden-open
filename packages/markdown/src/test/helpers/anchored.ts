// Test fixtures written the old way (`text ^id`) turned into the new shape: the text without the marks, and the
// block_anchors rows that carry the ids. Lets a test keep a readable note ("which block has which id") while the code
// under test only ever sees what production sees. Uses stripLegacyIds, so what it returns is what the migration writes.

import { stripLegacyIds } from "../../legacyBlockIds.js";

export type TestAnchor = { id: string; from: number; to: number };

/** `legacy` without its `^id` marks, and one anchor per id (a repeated id keeps its first block). Throws when the
 *  fixture cannot be converted, so a broken fixture fails loudly instead of testing something else. */
export function anchored(legacy: string): { markdown: string; anchors: TestAnchor[] } {
  const out = stripLegacyIds(legacy);
  if ("refused" in out) throw new Error(`fixture not convertible: ${out.refused}`);
  return { markdown: out.markdown, anchors: out.anchors.filter((a) => !a.repeat).map(({ id, from, to }) => ({ id, from, to })) };
}
