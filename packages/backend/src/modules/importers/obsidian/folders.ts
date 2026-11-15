import { assertAuthority, AuthorityError } from "../../../spine/authority.js";
import { withEventTransaction } from "../../../spine/eventTransaction.js";
import { ScopeError } from "../../../spine/toolScope.js";
import { canReadNode } from "../../../services/readPolicy.js";
import { findImportedFolders, stampImportedFolder, importSourceMeta } from "../shared/identity.js";
import type { ActorCtx } from "../../../types.js";
import { createNote, NoteCreateError } from "../../../services/noteCreate.js";
import { clampNoteTitle } from "@onden/markdown";
import type { ImportSource } from "@onden/contract";

class FolderConflict extends Error {}

/** Resolve relative folder paths for one upload, preserving existing names,
 * bodies and parents. With reuse=false, create a separate tree. A missing map
 * entry means that folder AND its descendants must be skipped, never rooted.
 * Each folder commits independently; unknown storage failures propagate.
 *
 * `folderNote(path, parentId)`: a folder with its own note (services/
 * vaultPath.ts folderNoteFile: `課程.md` beside `課程/`, how an export writes
 * a parent note) is that note. It is called once per folder, parents first,
 * and answers the note's id — the folder's children go under it, and no
 * separate folder note is made — or null to make (or reuse) a plain folder.
 * A folder it answers for is not counted as created or reused.
 * Example: importObsidianFolders({ actor, workspaceId, paths: ["課程/演算法"], reuse: true }). */
export async function importObsidianFolders(options: {
  actor: ActorCtx; workspaceId: string; paths: Iterable<string>; reuse: boolean; source?: ImportSource;
  folderNote?: (path: string, parentId: string | null) => Promise<string | null>;
}) {
  const { actor, workspaceId, reuse, source = { id:"legacy",name:"Older imports" } } = options;
  const ids = new Map<string, string>();
  const allPaths = new Set<string>();
  for (const path of options.paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) allPaths.add(parts.slice(0, i).join("/"));
  }
  let created = 0, reused = 0, skipped = 0;
  for (const path of [...allPaths].sort()) {
    const parts = path.split("/");
    // A folder's title is its name, cut to the note title cap (no file system
    // names a folder that long, so nothing reports it).
    const name = clampNoteTitle(parts.pop()!);
    const parentPath = parts.join("/");
    const parentId = parentPath ? ids.get(parentPath) : null;
    if (parentPath && !parentId) { skipped++; continue; }
    const noteId = await options.folderNote?.(path, parentId ?? null);
    if (noteId) { ids.set(path, noteId); continue; }
    try {
      const folder = await withEventTransaction(workspaceId, async () => {
        await assertAuthority(actor, { kind: "any_space_write" });
        if (parentId) {
          if (!(await canReadNode(actor, parentId))) throw new FolderConflict();
          await assertAuthority(actor, { kind: "node", nodeId: parentId, op: "write_node" });
        }
        if (reuse) {
          // Creation provenance prevents a user/frontmatter attribute from
          // turning an unrelated note into a folder. Legacy folders are only
          // adopted by an unambiguous name + parent + import creation event.
          const matches = await findImportedFolders(workspaceId,source,path,name,parentId ?? null);
          if (matches.length > 1) throw new FolderConflict();
          const existing = matches[0];
          if (existing) {
            if (existing.deleted_at || existing.parent_id !== (parentId ?? null) || !(await canReadNode(actor, existing.id))) throw new FolderConflict();
            await assertAuthority(actor, { kind: "node", nodeId: existing.id, op: "write_node" });
            // This reserved derived index adopts old import identity only; it
            // changes no user content or policy and needs no content event.
            await stampImportedFolder(workspaceId,existing.id,source,path);
            return { id: existing.id, reused: true };
          }
        }
        // services/noteCreate.ts: the creator's space and the create chain;
        // the folder's import stamp rides the same NODE_CREATED.
        const { node } = await createNote({
          actor, workspaceId, title: name, parentId: parentId ?? null,
          event: { uiContext: "import.obsidian.folder", txMeta: importSourceMeta(source) },
          within: async ({ nodeId }) => { await stampImportedFolder(workspaceId, nodeId, source, path); },
        });
        const id = node.id as string;
        return { id, reused: false };
      });
      ids.set(path, folder.id);
      if (folder.reused) reused++; else created++;
    } catch (error) {
      if (!(error instanceof FolderConflict || error instanceof AuthorityError || error instanceof ScopeError || error instanceof NoteCreateError)) throw error;
      skipped++;
    }
  }
  return { ids, created, reused, skipped };

}
