// A Notion export as the folder import is sent it (a database as `<DB>.csv`
// plus `<DB>_all.csv`, its row pages as `<DB>/<Title> <32 hex>.md`, other pages
// beside them), generated with fast-check. Every page carries a token no other
// page has, so a test can tell whose body a note holds. Titles repeat on
// purpose: in one database, across databases, and between a row and a page
// outside the database.

import fc from "fast-check";
import { fileNameFor } from "./roundTripVault.js";
import { titleText, titleIdentity } from "./roundTripArb.js";
import type { ImportFile } from "./roundTripApi.js";

export type NotionRow = { title: string; /** Unique in the export: tells the row's note apart. */ status: string; page: boolean };
export type NotionDb = { name: string; rows: NotionRow[] };
export type NotionLoose = { folder: string | null; title: string };
export type NotionSpec = { databases: NotionDb[]; loose: NotionLoose[] };

/** Titles Notion exports often have more than once. */
const COMMON = ["Untitled", "Meeting notes", "會議紀錄", "Reading list", "Draft"];

const dbName = fc.constantFrom("Tasks", "Books 書單", "Projects", "Journal", "Reading");

export type Collision = "none" | "sameDb" | "twoDbs" | "looseSameTitle";

/** A Notion export; `collision` plants one kind of repeated title (or none:
 *  then every title is unique across rows and pages). */
export function notionSpec(collision: Collision): fc.Arbitrary<NotionSpec> {
  const title = fc.oneof({ arbitrary: titleText.map(fileNameFor), weight: 3 }, { arbitrary: fc.constantFrom(...COMMON), weight: 1 });
  return fc.record({
    names: fc.uniqueArray(dbName, { minLength: collision === "twoDbs" ? 2 : 1, maxLength: 3 }),
    titles: fc.array(title, { minLength: 8, maxLength: 12 }),
    rowCounts: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 }),
    pageRolls: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
    looseCount: fc.integer({ min: 1, max: 3 }),
    folderRoll: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  }).map(({ names, titles, rowCounts, pageRolls, looseCount, folderRoll }): NotionSpec => {
    // Unique titles first; a collision is planted on top.
    const seen = new Set<string>(names.map(titleIdentity));
    let next = 0;
    const unique = (): string => {
      let t = titles[next % titles.length]!;
      while (seen.has(titleIdentity(t)) || !t) t = `${t || "page"} ${++next}`;
      next++;
      seen.add(titleIdentity(t));
      return t;
    };
    let n = 0;
    const databases: NotionDb[] = names.map((name, d) => ({
      name,
      rows: Array.from({ length: rowCounts[d]! }, (): NotionRow => ({ title: unique(), status: `s${n++}`, page: n === 1 || pageRolls[n % pageRolls.length]! })),
    }));
    const loose: NotionLoose[] = Array.from({ length: looseCount }, (_, i) => ({ folder: folderRoll[i]! ? "Archive" : null, title: unique() }));

    const first = databases[0]!.rows[0]!;
    first.page = true;
    if (collision === "sameDb") databases[0]!.rows.push({ title: first.title, status: `s${n++}`, page: true });
    if (collision === "twoDbs") { const other = databases[1]!.rows[0]!; other.title = first.title; other.page = true; }
    if (collision === "looseSameTitle") loose.push({ folder: "Archive", title: first.title });
    return { databases, loose };
  });
}

export type NotionPage = { token: string; path: string; db: string | null; rowStatus: string | null; title: string };

const hex = (k: number) => k.toString(16).padStart(32, "0");
const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The files of `spec`, and the pages in them by token. */
export function notionFiles(spec: NotionSpec): { files: ImportFile[]; pages: NotionPage[] } {
  const files: ImportFile[] = [];
  const pages: NotionPage[] = [];
  let k = 0;
  const page = (path: string, title: string, db: string | null, rowStatus: string | null) => {
    const token = `PAGE-${k}-t${k * 7}`;
    files.push({ path: `${path}/${title} ${hex(++k)}.md`.replace(/^\//, ""), content: `# ${title}\n\n${token} 內文 body\n\nSecond paragraph of ${token}.\n` });
    pages.push({ token, path: files[files.length - 1]!.path, db, rowStatus, title });
  };
  for (const db of spec.databases) {
    const csv = `Name,Status\n${db.rows.map((r) => `${csvCell(r.title)},${r.status}`).join("\n")}\n`;
    files.push({ path: `${db.name}.csv`, content: csv }, { path: `${db.name}_all.csv`, content: csv });
    for (const row of db.rows) if (row.page) page(db.name, row.title, db.name, row.status);
  }
  for (const p of spec.loose) page(p.folder ?? "", p.title, null, null);
  return { files, pages };
}
