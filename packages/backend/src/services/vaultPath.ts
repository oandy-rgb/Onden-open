// Where a note lives in a Markdown vault (D109): the one rule the zip export
// writes with and the folder import reads with, so export → import gives the
// same tree back.
//
//   a note             <path>.md
//   a note's children  <path>/<child>.md          (its folder)
//
// A parent note is a folder plus its own file beside it, `課程.md` next to
// `課程/` (the "folder note outside the folder" convention of Obsidian's
// folder-note plugins). The importer reads it back the same way: a folder
// that has a same-name `.md` beside it IS that note (folderNoteFile), not an
// empty folder note plus a second note of the same name.
//
//   vaultPaths([{ id: "a", title: "課程", slug: "ke-cheng", parent_id: null },
//               { id: "b", title: "演算法", slug: "suan-fa", parent_id: "a" }])
//   → Map { "a" → "課程", "b" → "課程/演算法" }
//
// A file is named by the note's title — what Obsidian resolves `[[Title]]` by
// — with the characters a file system or a link cannot carry replaced by a
// space; a clash within a folder gets " 2", " 3"… (`Title.md`, `Title 2.md`).

import { cutToBytes, linkNameKey } from "@onden/markdown";

/** The longest a file or folder name is made, in UTF-8 bytes: a disk takes 255
 *  per name, and a Chinese character is 3 (a 200-character title is 600). The
 *  room left is for a `-<id>` suffix that keeps names unique and for `.md`. */
const NAME_BYTES_MAX = 200;

/** What a note's place in a vault depends on. */
export type VaultPlacement = {
  id: string; title: string; slug: string | null; parent_id: string | null;
  /** Names the note already answers to (its `aliases` attribute, decoded). */
  aliases?: readonly string[];
};

/** Characters no file name may hold on some system (Windows, macOS, Linux) or
 *  that end a link target (`# ^ [ ] |`, Obsidian's own list), and controls. */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]+/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A file or folder name for `node`: its title, else its slug, else its id,
 *  with unsafe characters replaced by a space (runs collapse). Nothing in it
 *  leaves its folder, starts with a dot (no hidden file, no `.trash`/`.onden`
 *  folder, which a backup reserves: services/backupFile.ts), or ends in a dot
 *  or blank (Windows). */
export function vaultName(node: { id: string; title?: string; slug: string | null }): string {
  for (const source of [node.title, node.slug]) {
    const text = source?.normalize("NFC").replace(UNSAFE_NAME_CHARS, " ").replace(/\s+/g, " ").replace(/^[.\s]+/, "");
    // Cut on a character boundary.
    let name = text ? cutToBytes(text, NAME_BYTES_MAX).replace(/[. ]+$/, "").trim() : "";
    if (name && WINDOWS_RESERVED.test(name)) name = `${name} note`;
    if (name) return name;
  }
  return node.id;
}

/** Each note's path in the vault, sans `.md`, by id: its ancestors' names as
 *  folders, then its own name. Only parents among `nodes` count — a note
 *  whose parent is not exported (unreadable, hidden, deleted) is at the root,
 *  and a parent cycle (which the database forbids, but an archive must not
 *  hang on) is cut where it is found, that note going to the root.
 *
 *  Names are unique per folder, ignoring case (a vault may be unzipped on a
 *  case-insensitive disk): among siblings the first in `nodes` order keeps
 *  its name, a later one gets `<name> 2`, `<name> 3`…. Callers order
 *  `nodes` deterministically (by title), so the same notes get the same
 *  paths twice. A folder takes its note's final name, so `P.md` and `P/`
 *  always match.
 *
 *  A file name that is not the note's title (cleaned, cut, or ` 2`) becomes
 *  its alias (exportZip.ts fileNameAlias), and Onden resolves a name across the
 *  whole space, titles and aliases alike. So such a name must also be unused by
 *  every other note's title, every alias, and every other generated alias, in
 *  any folder; otherwise `[[Meeting 2]]` would reach two notes. */
export function vaultPaths(nodes: readonly VaultPlacement[]): Map<string, string> {
  const ids = new Set(nodes.map((n) => n.id));
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parent_id && n.parent_id !== n.id && ids.has(n.parent_id) ? n.parent_id : null);
  // Cut cycles: walk up from each note; meeting the walk again is a cycle.
  const settled = new Set<string>();
  for (const n of nodes) {
    const walk: string[] = [];
    const onWalk = new Set<string>();
    let at: string | null = n.id;
    while (at !== null && !settled.has(at)) {
      if (onWalk.has(at)) { parentOf.set(walk[walk.length - 1]!, null); break; }
      walk.push(at);
      onWalk.add(at);
      at = parentOf.get(at) ?? null;
    }
    for (const id of walk) settled.add(id);
  }

  const children = new Map<string | null, VaultPlacement[]>();
  for (const n of nodes) {
    const parent = parentOf.get(n.id) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }
  const paths = new Map<string, string>();
  // Who answers to each name (by link key): titles and aliases of every note.
  // A note may take a name only it holds (its own alias from an earlier export).
  const holders = new Map<string, Set<string>>();
  const hold = (key: string, id: string) => holders.set(key, (holders.get(key) ?? new Set<string>()).add(id));
  for (const n of nodes) {
    hold(linkNameKey(n.title), n.id);
    for (const a of n.aliases ?? []) hold(linkNameKey(a), n.id);
  }
  // Breadth-first from the root: a folder's names are settled before its
  // children are placed in it.
  const queue: Array<{ parent: string | null; folder: string }> = [{ parent: null, folder: "" }];
  for (let i = 0; i < queue.length; i++) {
    const { parent, folder } = queue[i]!;
    const taken = new Set<string>();
    for (const n of children.get(parent) ?? []) {
      const own = vaultName(n);
      const titleKey = linkNameKey(n.title);
      const usable = (candidate: string) => {
        if (taken.has(candidate.toLowerCase())) return false;
        const key = linkNameKey(candidate);
        return titleKey === "" || key === titleKey || [...(holders.get(key) ?? [])].every((id) => id === n.id);
      };
      let name = own;
      for (let k = 2; !usable(name); k++) name = `${own} ${k}`;
      taken.add(name.toLowerCase());
      if (titleKey !== "" && linkNameKey(name) !== titleKey) hold(linkNameKey(name), n.id);
      const path = folder + name;
      paths.set(n.id, path);
      if (children.has(n.id)) queue.push({ parent: n.id, folder: `${path}/` });
    }
  }
  return paths;
}

/** The folder `filePath` is in, or null at the vault root. */
export function parentFolderOf(filePath: string): string | null {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? null : filePath.slice(0, slash);
}

/** The file holding `folder`'s own note: `課程` → `課程.md`, beside it. */
export function folderNoteFile(folder: string): string {
  return `${folder}.md`;
}

/** How many folders down from the vault root `filePath` is (`a.md` 0,
 *  `a/b.md` 1): a relative link from it climbs this many `../`. */
export function folderDepth(filePath: string): number {
  return filePath.split("/").length - 1;
}
