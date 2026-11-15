// A link target that names a node by id, not by title: `onden://node/<uuid>`
// (the scheme backups and the zip export already use for a node reference).
// Written as `[[onden://node/<id>|Title]]` / `![[onden://node/<id>]]`, so the
// link grammar, embeds, edges and the published site's redaction need no new
// syntax — and two nodes with one title cannot be mixed up. Used for tasks,
// which have no slug and often share a title.

import { UUID_SOURCE } from "./uuid.js";

export const NODE_REF_PREFIX = "onden://node/";

const NODE_REF = new RegExp(`^onden://node/(${UUID_SOURCE})$`, "i");

/** The link target that names node `id`. */
export function nodeRefTarget(id: string): string {
  return NODE_REF_PREFIX + id.toLowerCase();
}

/** The node id (lowercase) a link target names by id, or null for a title. */
export function nodeRefId(target: string): string | null {
  return NODE_REF.exec(target.trim())?.[1]?.toLowerCase() ?? null;
}
