// An Obsidian-shaped vault as the folder import is sent it, made from a
// generated world (roundTripArb.ts): file names for titles (Obsidian forbids
// `\ / : * ? " < > | # ^ [ ]` in them), a folder per parent note with the
// parent's own file beside it (the folder-note convention, services/vaultPath.ts),
// YAML frontmatter with tags, aliases and properties, `[[wikilinks]]`, embeds
// and block references in the bodies, and the pictures as attachments.

import { createHash } from "node:crypto";
import sharp from "sharp";
import { attributeValues, entryFor, isListValue, writeFrontmatter, type FrontmatterEntry } from "@onden/markdown";
import { titleIdentity, type NoteSpec, type WorldSpec } from "./roundTripArb.js";
import type { ImportFile } from "./roundTripApi.js";
import { renderBody } from "./roundTripRender.js";

const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** A file name Obsidian accepts, made from a title. */
export function fileNameFor(title: string): string {
  const name = title.replace(FORBIDDEN, " ").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
  return name || "note";
}

async function png(seed: string): Promise<Buffer> {
  const n = createHash("sha1").update(seed).digest();
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: n[0]!, g: n[1]!, b: n[2]! } } }).png().toBuffer();
}

export type Vault = {
  files: ImportFile[];
  /** The file name (title) of each note of the spec, by index. */
  names: string[];
  /** Path of each note's file, by index. */
  paths: string[];
};

/** The vault of `spec`: live notes only, no canvas, no odd attribute keys. */
export async function vaultOf(spec: WorldSpec): Promise<Vault> {
  const names: string[] = [];
  const seen = new Set<string>();
  spec.notes.forEach((note, i) => {
    let name = fileNameFor(note.title);
    while (seen.has(titleIdentity(name))) name = `${name} ${i}`;
    seen.add(titleIdentity(name));
    names.push(name);
  });
  // Links name files, so the bodies are rendered against the file names, and
  // as [[wikilinks]]: Obsidian has no other note link.
  const asFiles: NoteSpec[] = spec.notes.map((note, i) => ({
    ...note, title: names[i]!,
    blocks: note.blocks.map((b) => (b.kind === "link" ? { ...b, via: "wikilink" as const } : b)),
  }));
  const fileSpec: WorldSpec = { ...spec, notes: asFiles };

  const folderOf = (i: number): string => {
    const parent = spec.notes[i]!.parent;
    return parent === null ? "" : `${folderOf(parent)}${names[parent]}/`;
  };
  const files: ImportFile[] = [];
  const paths: string[] = [];
  for (const [i, note] of asFiles.entries()) {
    const entries: FrontmatterEntry[] = [];
    if (note.tags.length) entries.push(entryFor("tags", note.tags.map((t) => tagPath(spec, t))));
    if (i % 3 === 0) entries.push(entryFor("aliases", [`${names[i]} alias`]));
    for (const a of note.attrs) entries.push(entryFor(a.key, isListValue(a.value) ? attributeValues(a.value) : a.value));
    const front = writeFrontmatter(entries);
    const picture = note.media ? `pic-${i}.png` : undefined;
    // An Obsidian picture is embedded by name: ![[pic-3.png]].
    // What only a vault has: callouts, an inline #tag, a link to a heading.
    const extras = [
      i % 2 === 0 ? `> [!note] ${names[i]}\n> A callout.` : "",
      i % 4 === 1 ? `Filed under #inline-${i}` : "",
      asFiles.length > 1 ? `See [[${names[(i + 1) % asFiles.length]}#Section]]` : "",
    ].filter(Boolean);
    const body = [renderBody(note, i, fileSpec, [], undefined).trimEnd(), ...extras, picture ? `![[${picture}]]` : ""].filter(Boolean).join("\n\n") + "\n";
    const path = `${folderOf(i)}${names[i]}.md`;
    paths.push(path);
    files.push({ path, content: front ? `${front}\n${body}` : body });
    if (picture) files.push({ path: `attachments/${picture}`, base64: (await png(`${i}`)).toString("base64"), kind: "media" });
  }
  return { files, names, paths };
}

function tagPath(spec: WorldSpec, index: number): string {
  const tag = spec.tags[index]!;
  // An Obsidian tag has no spaces.
  const name = tag.name.replace(/\s+/g, "-");
  return tag.parent === null ? name : `${tagPath(spec, tag.parent)}/${name}`;
}
