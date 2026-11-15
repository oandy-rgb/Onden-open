// Relation values of imported notes (D91). A relation field stores a note id
// (value_type node_ref), which means nothing in another workspace, so the
// Markdown export writes it as `[[Title]]` — a list as a list of them
// (services/exportZip.ts relationsAsLinks). Once the notes of an import
// request exist, each such frontmatter value of an Onden export is resolved
// back to the note it names in the importing note's space, by the one
// `[[link]]` rule (wikilinkEdges.ts wikilinkTargets), and stored as the
// relation. A link naming no note the importer can read, or more than one,
// keeps its text (the frontmatter value) and is reported.
//
// The id is written as an explicit value (setNodeAttribute, source ui), so
// the `[[Title]]` line that stays in the note's frontmatter (a lower-ranked
// rail) does not turn it back into text on the next save, and the next export
// writes the same line again.

import { readFrontmatter, encodeValues, entryValue, soleWikilink, wikilinkTarget, isSystemAttr } from "@onden/markdown";
import type { ActorCtx } from "../../../types.js";
import { AuthorityError } from "../../../spine/authority.js";
import { ScopeError } from "../../../spine/toolScope.js";
import { setNodeAttribute, AttributeWriteError } from "../../../services/attributeWrites.js";
import { canReadNode } from "../../../services/readPolicy.js";
import { isOndenExport, ONDEN_EXPORT_KEYS } from "../markdown/note.js";
import { wikilinkTargets } from "../../../services/wikilinkEdges.js";

/** One relation value that stayed text: the file, the key and the value. */
export type UnresolvedRelation = { path: string; key: string; value: string };

/** A value that is wholly one `[[link]]`: its target, else null. */
const linkTarget = (value: string): string | null => {
  const link = soleWikilink(value.trim());
  return (link && wikilinkTarget(link.body)) || null;
};

/** The relation links in one imported file: each frontmatter value of an
 *  Onden export that is one `[[link]]` or a list of only such links. */
function relationLinks(content: string): Array<{ key: string; targets: string[]; list: boolean; text: string }> {
  const front = readFrontmatter(content);
  if (!front || !isOndenExport(front.entries)) return [];
  return front.entries.flatMap((entry) => {
    const value = entryValue(entry);
    if (!entry.key || value === undefined || ONDEN_EXPORT_KEYS.has(entry.key) || isSystemAttr(entry.key)) return [];
    const items = Array.isArray(value) ? value : [value];
    const targets = items.map(linkTarget);
    if (!items.length || targets.some((t) => t === null)) return [];
    return [{ key: entry.key, targets: targets as string[], list: Array.isArray(value), text: Array.isArray(value) ? encodeValues(value) : value }];
  });
}

/** Store the relations of the notes just imported (see the module comment).
 *  `notes`: each imported or updated file with its note and the content it
 *  was imported from. Each value is its own attribute write under the
 *  actor's own authority; a value the key's field refuses, or a note the
 *  actor may no longer write, keeps its text and is reported. Storage errors
 *  propagate (earlier values stay written). */
export async function resolveImportedRelations(options: {
  actor: ActorCtx; workspaceId: string; notes: Array<{ path: string; nodeId: string; content: string }>;
}): Promise<{ resolved: number; unresolved: UnresolvedRelation[] }> {
  const { actor, workspaceId } = options;
  let resolved = 0;
  const unresolved: UnresolvedRelation[] = [];
  for (const note of options.notes) {
    const relations = relationLinks(note.content);
    if (!relations.length) continue;
    const named = await wikilinkTargets(workspaceId, note.nodeId, [...new Set(relations.flatMap((r) => r.targets))]);
    for (const relation of relations) {
      const ids: string[] = [];
      for (const target of relation.targets) {
        const readable: string[] = [];
        for (const id of named.get(target) ?? []) if (await canReadNode(actor, id)) readable.push(id);
        if (readable.length === 1) ids.push(readable[0]!);
      }
      const keep = () => unresolved.push({ path: note.path, key: relation.key, value: relation.text });
      if (ids.length !== relation.targets.length) { keep(); continue; }
      try {
        await setNodeAttribute({ workspaceId, actor, nodeId: note.nodeId,
          attribute: { key: relation.key, value: relation.list ? encodeValues(ids) : ids[0]!, value_type: "node_ref" } });
        resolved++;
      } catch (error) {
        if (!(error instanceof AttributeWriteError || error instanceof AuthorityError || error instanceof ScopeError)) throw error;
        keep();
      }
    }
  }
  return { resolved, unresolved };
}
