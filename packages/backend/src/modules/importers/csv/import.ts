// CSV import: parse a flat CSV (Notion/Airtable export shape) into rows.
//
// Pure, dependency-free RFC-4180-ish parser: handles quoted fields, embedded
// commas/newlines, and "" escaped quotes. The import turns each table into a
// collection (modules/importers/notion/database.ts).

export type CsvTable = { header: string[]; rows: string[][] };

/** Parse CSV text into a header row + data rows. Returns null if empty. */
export function parseCsv(text: string): CsvTable | null {
  const records = parseCsvRecords(text);
  if (records.length === 0) return null;
  const header = records[0]!.map((h) => h.trim());
  const rows = records.slice(1).filter((r) => r.some((cell) => cell.trim() !== ""));
  return { header, rows };
}

/** Tokenize CSV into an array of records (each a string[] of fields). */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // any char (incl. empty quoted field) seen on this row

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); records.push(row); row = []; started = false; };

  // Strip a UTF-8 BOM if present.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; started = true; continue; }
    if (ch === ",") { pushField(); started = true; continue; }
    if (ch === "\r" && s[i + 1] === "\n") continue; // CRLF: the \n ends the row
    if (ch === "\n" || ch === "\r") { // a lone \r (old Mac exports) ends a row too
      if (started || field !== "" || row.length > 0) pushRow();
      continue;
    }
    field += ch;
    started = true;
  }
  // Trailing record (no final newline).
  if (started || field !== "" || row.length > 0) pushRow();
  return records;
}
