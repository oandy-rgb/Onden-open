import { expect } from "vitest";
import { createHash } from "node:crypto";
// Comparing what went out of a workspace with what came back (round-trip
// tests). The normalisations here are the documented, intentional differences
// of a Markdown trip; anything not listed is a difference the test reports.

import { posix } from "node:path";
import { readFrontmatter, entryValue, entryFor, stripFrontmatter, stripLegacyIds } from "@onden/markdown";
import type { NoteSnapshot, WorldSnapshot } from "./roundTripWorld.js";
import type { Zip } from "./roundTripApi.js";
import { LEFT_OUT_FILE } from "../../services/exportLeftOut.js";

/** The title in an exported file's frontmatter. */
export function fileTitle(text: string): string | undefined {
  const entry = readFrontmatter(text)?.entries.find((e) => e.key === "title");
  const value = entry && entryValue(entry);
  return typeof value === "string" ? value : undefined;
}

export const noteFiles = (zip: Zip) => [...zip].filter(([name]) => name.endsWith(".md"));

/** The Markdown trip's documented normalisation of an imported body:
 *   - the frontmatter the importer keeps in the stored body is cut (the
 *     attributes are compared on their own), with the blank line the export
 *     writes after it, and
 *   - a note link the export wrote as a relative file link
 *     (`[x](../dir/other.md)`, services/exportZip.ts rewriteLinks) is read as
 *     a link to the note that file holds, as `onden://node/<title>`. */
export function importedBody(note: NoteSnapshot, zip: Zip): string {
  const own = noteFiles(zip).find(([, data]) => fileTitle(data.toString("utf8")) === note.title);
  const dir = own ? posix.dirname(own[0]) : ".";
  const titleAt = new Map(noteFiles(zip).map(([name, data]) => [name, fileTitle(data.toString("utf8"))] as const));
  // A link to a note whose file name is not its title names the file (`[[File 2|shown]]`,
  // exportZip.ts wikilinksByFileName); the note's alias brings it back to the title, and the
  // test reads it as the link the note started with.
  const titleOfFile = new Map(noteFiles(zip).map(([name, data]) => [posix.basename(name, ".md"), fileTitle(data.toString("utf8"))] as const));
  const byTitle = (text: string) => text.replace(/\[\[([^\]|#\n]+)((?:#[^\]|\n]*)?\|[^\]\n]*)\]\]/g, (m, file: string, rest: string) => {
    const title = titleOfFile.get(file);
    return title && title !== file ? `[[${title}${rest}]]` : m;
  });
  return byTitle(stripFrontmatter(note.body)).replace(/^(\r?\n)+/, "").replace(/\]\(((?:\.\.?\/)[^)\s]*?\.md)\)/g, (m, rel: string) => {
    const title = titleAt.get(posix.normalize(posix.join(dir, decodeURIComponent(rel))));
    return title === undefined ? m : `](onden://node/<${title}>)`;
  });
}

/** A tag path and every ancestor path of it. */
export function withAncestors(paths: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  return [...all].sort();
}

/** The notes of `snapshot` a Markdown export carries: the live ones. */
export const liveNotes = (snapshot: WorldSnapshot) => snapshot.notes.filter((n) => !n.deleted);

/** Frontmatter that changes on every trip by design: the importer drops the
 *  exported `id:` and `updated_at:` (modules/importers/markdown/note.ts), and the order
 *  of `tags:` is the order they were applied in, which a set of tags has none
 *  of (notes tagged in one import are applied in one transaction). */
export function withoutVolatileLines(text: string): string {
  const front = readFrontmatter(text);
  if (!front) return text;
  const keep = front.entries.filter((e) => e.key !== "id" && e.key !== "updated_at").map((e) => {
    const value = e.key === "tags" ? entryValue(e) : undefined;
    return Array.isArray(value) ? entryFor("tags", [...value].sort()) : e;
  });
  return `---\n${keep.flatMap((e) => e.lines).join("\n")}\n---\n${front.body}`;
}

/** Relative `.md` links in a file that point at nothing in the zip. */
export function danglingLinks(zip: Zip): Array<{ file: string; link: string }> {
  const names = new Set(zip.keys());
  const out: Array<{ file: string; link: string }> = [];
  for (const [file, data] of noteFiles(zip)) {
    for (const m of data.toString("utf8").matchAll(/\]\(((?:\.\.?\/)[^)\s]*?\.md)\)/g)) {
      if (!names.has(posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(m[1]!))))) out.push({ file, link: m[1]! });
    }
  }
  return out;
}

/** A zip with each attachment named by its content: an import stores a copy of
 *  every media file under a new id (a workspace keeps its own copy), so two
 *  exports of the same notes name their attachments differently. The links in
 *  the Markdown files are renamed the same way. */
export function attachmentsByContent(zip: Zip): Zip {
  const renamed = new Map<string, string>();
  for (const [name, data] of zip) {
    if (name.startsWith("attachments/")) renamed.set(name.slice("attachments/".length), `${createHash("sha1").update(data).digest("hex").slice(0, 12)}${name.slice(name.lastIndexOf("."))}`);
  }
  const out: Zip = new Map();
  for (const [name, data] of zip) {
    if (name.startsWith("attachments/")) out.set(`attachments/${renamed.get(name.slice("attachments/".length))}`, data);
    else if (name.endsWith(".md")) out.set(name, Buffer.from(data.toString("utf8").replace(/attachments\/([0-9a-f]{32}\.[a-z0-9]+)/g, (m, file: string) => (renamed.has(file) ? `attachments/${renamed.get(file)}` : m))));
    else out.set(name, data);
  }
  return out;
}

/** The title in each tag page (`tag-<name>.md`) of an export: one per tag, not
 *  a note of the workspace. */
export const tagPageTitles = (zip: Zip) => noteFiles(zip).filter(([name]) => /(^|\/)tag-[^/]*\.md$/.test(name)).map(([, data]) => fileTitle(data.toString("utf8"))!);

const valuesOf = (attributes: Record<string, { value: string }>) => Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, v.value]));

/** What a Markdown trip must keep of every live note of `before`: it exists in
 *  `after` with the same parent, body (importedBody), tags, links, block
 *  references and attribute values, and the tag hierarchy is the one the live
 *  notes use. A tag page that came back as a plain note is not counted (the
 *  NEW failure in exportImportRoundTrip.property.test.ts pins that one). */
export function expectNotesSurvive(before: WorldSnapshot, after: WorldSnapshot, zip: Zip): void {
  const expected = liveNotes(before);
  const pages = new Set(tagPageTitles(zip));
  const imported = after.notes.filter((n) => !(pages.has(n.title) && n.body === "" && !expected.some((e) => e.title === n.title)));
  expect(imported.map((n) => n.title).sort()).toEqual(expected.map((n) => n.title).sort());
  for (const want of expected) {
    const got = imported.find((n) => n.title === want.title)!;
    expect(got.parent, `parent of ${want.title}`).toBe(want.parent);
    // `before` may itself be an import (frontmatter kept in its bodies), so both sides are read the same way.
    expect(importedBody(got, zip), `body of ${want.title}`).toBe(importedBody(want, zip));
    expect(got.tags, `tags of ${want.title}`).toEqual(want.tags);
    expect(got.links, `links of ${want.title}`).toEqual(want.links);
    // The export writes each paragraph's ` ^id` (Obsidian's block id) and the import makes the anchor of it again.
    expect(got.blockRefs, `block refs of ${want.title}`).toEqual(want.blockRefs);
    // Values survive exactly; a text value may come back typed (7 → number).
    // An export names a file in the note's `aliases` when it is not the title (`:`, a duplicate title).
    const gotValues = valuesOf(got.attributes);
    if (!("aliases" in want.attributes)) delete gotValues.aliases;
    expect(gotValues, `attributes of ${want.title}`).toEqual(valuesOf(want.attributes));
    for (const [key, attr] of Object.entries(want.attributes)) {
      if (attr.type !== "text") expect(got.attributes[key]!.type, `type of ${want.title}.${key}`).toBe(attr.type);
    }
  }
  expect(after.tags.map((t) => t.path)).toEqual(withAncestors(expected.flatMap((n) => n.tags)));
}

/** A `^id` typed into a note's text is plain text until an import reads it as an anchor and takes it out of the text,
 *  so the first export may have a mark the second writes for a different reason (or not at all): left out here. */
function withoutMarks(file: string): string {
  const out = stripLegacyIds(file);
  return "refused" in out ? file : out.markdown;
}

/** The second export holds the first's files, apart from what a trip changes
 *  by design (withoutVolatileLines, attachmentsByContent) and the report of
 *  what the export left out (the trash and canvases are not imported, so the
 *  second export has nothing to report). */
export function expectSameExport(first: Zip, second: Zip): void {
  const notReport = ([name]: [string, Buffer]) => !Object.values(LEFT_OUT_FILE).includes(name);
  const a = new Map([...attachmentsByContent(first)].filter(notReport));
  const b = new Map([...attachmentsByContent(second)].filter(notReport));
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [name, data] of a) {
    if (name.endsWith(".md")) expect(withoutMarks(withoutVolatileLines(b.get(name)!.toString("utf8"))), name).toBe(withoutMarks(withoutVolatileLines(data.toString("utf8"))));
    else expect(b.get(name)!.equals(data), name).toBe(true);
  }
}
