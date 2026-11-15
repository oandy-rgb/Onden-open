// The attribute value rule — how a value a person types (or a writer derives)
// is checked against its schema field and which storage type
// (node_attributes.value_type) it is stored under. One copy for the server and
// the app: the server decides what is stored, the app uses the same rule for
// its optimistic rows and for inferring a new field's type.
//
// Why the storage type matters: collection sorts and range filters read typed
// values only from rows whose value_type says so (a date range keeps only
// value_type='date' rows). Before this module each writer picked value_type
// itself with its own rule, so the same date was stored as 'date' from the
// panel and as 'text' from a table cell, and only one of them was found.
//
// Contract:
//   * storageType(fieldType)   — the value_type a schema field's values use
//                                (rating → number, boolean → bool, relation →
//                                node_ref; textual types → text).
//   * governingField(fields)   — which of the schema fields declaring a key
//                                governs it: none when they disagree on the
//                                storage type (the key is then free-form).
//   * normalize(field, raw)    — the stored form of `raw` under `field`, or why
//                                the field refuses it. An empty value is text.
//                                With no governing field the key is free-form:
//                                the writer's hint, else freeFormType(raw).
//   * freeFormType(raw)        — the storage type of a value with no field and
//                                no hint: inferred like a new field's type.
//   * inferFieldType(raw)      — the field type a new key gets from its first
//                                value (number, date, boolean, else text).
//   * inferFromValue(value)    — the storage type of a JS value with no field
//                                (number, boolean, date string, else text).
//   * isCalendarDate(s)        — the one date grammar: YYYY-MM-DD that exists
//                                on the calendar, optionally with a time
//                                (`T` or space, HH:MM[:SS[.fff]], zone).
//   * toCalendarDate(text)     — the YYYY-MM-DD a written date names
//                                ("October 16, 2026", "10/16/2026", ISO), or
//                                null: how an import reads another app's dates.
//   * calendarDayOf(value, zone) — the calendar day a stored value falls on
//                                (a date or wall-clock time names its own day;
//                                a zoned instant lands on its day in `zone`),
//                                or null: how a calendar view places a row.
//   * NUMBER_PATTERN           — the one number grammar, also the SQL guard of
//                                typed sorts, filters and rollups.
//   * isStoredNumber / storedNumber — the one numeric read of a stored value:
//                                value_type 'number' and NUMBER_PATTERN.
//   * storedValueType(raw, fields) — the value_type a value is stored under,
//                                given the schema fields declaring its key on
//                                its note's tags (for a reader without rows).
//   * compareAttribute / compareAttributeOrder — a stored value against a
//                                filter value, and two stored values for a
//                                sort, typed as the server's SQL reads them
//                                (filter/sqlClauses.ts, attributeSortSql).
//   * serializeValue / parseValue — a JS value to the stored string and back.
//   * attributeValues(raw) / encodeValues(list) / isListValue(raw) — the one
//                                codec of multi-value attributes (below).
//
// Multi-value attributes (D117). A list is one stored value: a JSON array of
// strings — `["ml","db"]` — whoever writes it (a frontmatter list, an imported
// relation list, the panel's list editor). attributeValues/encodeValues are the
// one codec; every reader decodes through attributeValues (export, the panel,
// the collection views) and the server's eq/ne and the app's compareAttribute
// match an element. Two rules decide the rest:
//   * the write gate checks each element of a list against its field when the
//     field is cardinality "many"; a single-value field is checked as before,
//     whole (a "one" select holding `["a"]` is still refused);
//   * a list is stored as text (value_type 'text'; a relation list keeps
//     node_ref), whatever its field's type: typed sorts, range filters and
//     rollups read numbers and dates only from rows of that type, and a list
//     is neither.

/** node_attributes.value_type: the values node_attributes_value_type_check
 *  accepts (db/schema.sql). */
export const ATTRIBUTE_VALUE_TYPES = ["text", "number", "date", "bool", "node_ref"] as const;
export type AttributeValueType = typeof ATTRIBUTE_VALUE_TYPES[number];

/** The schema field types (tag_schema.fields[].type) — the one list. The
 *  server's field shape check (backend services/fieldSchema.ts) is built from
 *  it, so a type added here is accepted at every door that writes a schema. */
export const ATTRIBUTE_FIELD_TYPES = [
  "text", "textarea", "richtext", "number", "rating", "boolean", "date", "select", "media", "relation",
] as const;
export type AttributeFieldType = typeof ATTRIBUTE_FIELD_TYPES[number];

/** The parts of a schema field the value rule reads. */
export type AttributeField = {
  name?: string;
  type?: string;
  required?: boolean;
  options?: string[];
  /** rating: the top of the scale (default 5). */
  max?: number;
  /** "many": the value is a list (attributeValues), each element checked
   *  against the field. Absent is "one". */
  cardinality?: "one" | "many";
};

export type NormalizedAttributeValue =
  | { ok: true; value: string; value_type: AttributeValueType }
  | { ok: false; reason: string };

/** The storage type of values of a field of `fieldType` (unknown → text). */
export function storageType(fieldType: string | undefined): AttributeValueType {
  switch (fieldType) {
    case "number":   return "number";
    case "rating":   return "number"; // stars are a plain number string: sort/filter/rollup treat it as numeric
    case "boolean":  return "bool";
    case "date":     return "date";
    case "relation": return "node_ref";
    default:         return "text";
  }
}

/** A stored number: optional minus, digits, optional decimal part — nothing
 *  else (no spaces, exponents, hex or "Infinity"). A POSIX/JS regex source,
 *  used as-is by the backend's numericValueSql (services/attributeNumber.ts:
 *  typed sorts, range filters, rollups), so every
 *  value stored as a number is one those reads see. */
export const NUMBER_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";
const NUMBER_RE = new RegExp(NUMBER_PATTERN);

/** Whether a stored attribute value reads as a number — the one numeric read
 *  rule, shared with the backend's numericValueSql (rollups, typed sorts and
 *  range filters): its value_type is 'number' and it matches NUMBER_PATTERN.
 *  "2h", "1e3", "NaN" and " 3" are not numbers. `valueType` undefined means
 *  the caller does not know the row's type; the pattern alone then decides
 *  (a free-form value matching it is stored as a number). */
export function isStoredNumber(value: string | null | undefined, valueType?: string): boolean {
  if (value == null) return false;
  if (valueType !== undefined && valueType !== "number") return false;
  return NUMBER_RE.test(value);
}

/** The number a stored attribute value holds under isStoredNumber, else null. */
export function storedNumber(value: string | null | undefined, valueType?: string): number | null {
  return isStoredNumber(value, valueType) ? Number(value) : null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/;

/** Whether `s` is a date Onden stores as one: YYYY-MM-DD naming a real
 *  calendar day (2026-02-30 and 2026-13-45 are not), optionally followed by a
 *  valid time of day and zone. Postgres can cast every accepted string to
 *  timestamptz, so a stored date never fails a typed filter. */
export function isCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false;
  // Postgres refuses a zone displacement past ±15:59 ("out of range").
  if (m[7] !== undefined && (Number(m[7]) > 15 || Number(m[8]) > 59)) return false;
  return true;
}

/** A bare YYYY-MM-DD naming a real day: isCalendarDate without a time of day —
 *  what a day id, a `when_date` or a route's `:date` holds. */
export function isCalendarDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && isCalendarDate(s);
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
// An optional time after a written date: "3:04 PM", "15:04", "15:04:05".
const TIME = "(?: (\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?: ?([AaPp][Mm]))?)?";
// "October 16, 2026" / "Oct 16, 2026" (Notion's "Full date" and its export).
const LONG_DATE_RE = new RegExp(`^([A-Za-z]{3,9})\\.? (\\d{1,2}), (\\d{4})${TIME}$`);
// "10/16/2026" (US month/day/year) and "2026/10/16" (year/month/day).
const MDY_DATE_RE = new RegExp(`^(\\d{1,2})/(\\d{1,2})/(\\d{4})${TIME}$`);
const YMD_DATE_RE = new RegExp(`^(\\d{4})/(\\d{1,2})/(\\d{1,2})${TIME}$`);

/** The calendar day a written date names, as the YYYY-MM-DD a date field
 *  stores, or null when `text` is not a real date. Reads what isCalendarDate
 *  reads (the time and zone are dropped), plus the written forms other apps
 *  export — "October 16, 2026", "Oct 16, 2026 3:04 PM", "10/16/2026" (month
 *  first) and "2026/10/16". A time is checked and then dropped: a date
 *  field's editor is a day picker, and an exported time carries no zone.
 *  Day-first dates ("16/10/2026") are not read: they are indistinguishable
 *  from month-first ones. */
export function toCalendarDate(text: string): string | null {
  const t = text.trim();
  if (isCalendarDate(t)) return t.slice(0, 10);
  let y: number, mo: number, d: number, time: RegExpExecArray;
  let m = LONG_DATE_RE.exec(t);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month === undefined) return null;
    [y, mo, d, time] = [Number(m[3]), month, Number(m[2]), m];
  } else if ((m = MDY_DATE_RE.exec(t))) {
    [y, mo, d, time] = [Number(m[3]), Number(m[1]), Number(m[2]), m];
  } else if ((m = YMD_DATE_RE.exec(t))) {
    [y, mo, d, time] = [Number(m[1]), Number(m[2]), Number(m[3]), m];
  } else {
    return null;
  }
  const [h, min, s, meridiem] = [time[4], time[5], time[6], time[7]];
  if (h !== undefined) {
    const hour = Number(h);
    if (meridiem !== undefined ? hour < 1 || hour > 12 : hour > 23) return null;
    if (Number(min) > 59 || (s !== undefined && Number(s) > 59)) return null;
  }
  const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isCalendarDate(iso) ? iso : null;
}

const ZONE_RE = /(?:Z|([+-])(\d{2}):?(\d{2}))$/;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The YYYY-MM-DD an instant (epoch ms) falls on in `timeZone`. */
function dayInZone(ms: number, timeZone: string | undefined): string {
  let format = dayFormats.get(timeZone ?? "");
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(timeZone ?? "", format);
  }
  const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** The calendar day (YYYY-MM-DD) a stored value falls on, or null when it
 *  names none — how a calendar view places a row. A date, or a date with a
 *  wall-clock time and no zone ("2026-10-14T00:30"), names its own day, as
 *  does a written date toCalendarDate reads ("2026/10/14", "Oct 14, 2026").
 *  A timestamp with a zone ("…Z", "…+08:00") is an instant, placed on its day
 *  in `timeZone` (an IANA zone; undefined is the runtime's own). Anything
 *  else is null — "10" and "Draft 2" included, though Date.parse reads them. */
export function calendarDayOf(value: string | null | undefined, timeZone?: string): string | null {
  if (value == null) return null;
  const t = value.trim();
  const m = DATE_RE.exec(t);
  const zone = m && m[4] !== undefined ? ZONE_RE.exec(t) : null;
  if (m && zone && isCalendarDate(t)) {
    const [y, mo, d, h, min, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as
      [number, number, number, number, number, number];
    const offsetMin = zone[1] === undefined ? 0 : (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
    return dayInZone(Date.UTC(y, mo - 1, d, h, min, s) - offsetMin * 60_000, timeZone);
  }
  return toCalendarDate(t);
}

/** The elements of a stored list, or null when `raw` is not one: a JSON array
 *  whose items are all strings (numbers and booleans read as their text, null
 *  as ""). An array holding objects or arrays is no list. */
function listItems(raw: string): string[] | null {
  if (raw.length < 2 || raw[0] !== "[" || raw[raw.length - 1] !== "]") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const items: string[] = [];
  for (const item of parsed) {
    if (item === null) items.push("");
    else if (typeof item === "string") items.push(item);
    else if (typeof item === "number" || typeof item === "boolean") items.push(String(item));
    else return null;
  }
  return items;
}

/** Whether a stored attribute value is a list (a JSON array of scalars). */
export function isListValue(raw: string | null | undefined): boolean {
  return raw != null && listItems(raw) !== null;
}

/** The values a stored attribute value holds: a list's elements
 *  (`["ml","db"]` → ml, db; `[]` → none), else the value itself as the only
 *  one ("" and null → none). A "[draft" or "[[Note]]" is not a list: it is one
 *  value. The field does not change the reading. */
export function attributeValues(raw: string | null | undefined): string[] {
  if (raw == null || raw === "") return [];
  return listItems(raw) ?? [raw];
}

/** The stored form of a list of values: "" for none, else the JSON array (a
 *  one-element list stays a list). attributeValues(encodeValues(xs)) is xs. */
export function encodeValues(values: readonly string[]): string {
  return values.length === 0 ? "" : JSON.stringify(values);
}

/** Why `field` refuses `value`, or null when it fits. An empty value is
 *  refused only by a required field. A "many" field's list is checked element
 *  by element (empty slots skipped; a required field needs one value); the
 *  reason names the first element that does not fit. */
export function fieldViolation(field: AttributeField, value: string | null): string | null {
  const name = field.name ?? "field";
  if (value === null || value === "") {
    return field.required ? `"${name}" is required` : null;
  }
  const items = field.cardinality === "many" ? listItems(value) : null;
  if (!items) return elementViolation(field, name, value);
  const present = items.filter((item) => item !== "");
  if (present.length === 0) return field.required ? `"${name}" is required` : null;
  for (const item of present) {
    const reason = elementViolation(field, name, item);
    if (reason) return reason;
  }
  return null;
}

/** Why `field` refuses one non-empty value. */
function elementViolation(field: AttributeField, name: string, value: string): string | null {
  switch (field.type) {
    case "number":
      return NUMBER_RE.test(value) ? null : `"${name}" must be a number`;
    case "rating": {
      // A small non-negative integer inside its scale, so a star widget never
      // renders a stray 99 or a fractional click ("3.0" is three stars).
      const n = Number(value);
      if (!NUMBER_RE.test(value) || !Number.isInteger(n) || n < 0) return `"${name}" must be a whole number of stars`;
      const max = typeof field.max === "number" && field.max > 0 ? field.max : 5;
      return n <= max ? null : `"${name}" must be ${max} stars or fewer`;
    }
    case "boolean":
      return value === "true" || value === "false" ? null : `"${name}" must be true or false`;
    case "date":
      return isCalendarDate(value) ? null : `"${name}" must be a date (YYYY-MM-DD)`;
    case "select":
      return !field.options?.length || field.options.includes(value)
        ? null : `"${name}" must be one of: ${(field.options ?? []).join(", ")}`;
    default:
      return null; // text/textarea/richtext/media/relation: free-form
  }
}

/** The field that governs a key, given every schema field (on the node's
 *  tags, in tag order) declaring it: the first, unless they disagree on the
 *  storage type — then none, and the key is free-form, so the stored type
 *  never depends on which tag happens to be read first. */
export function governingField<F extends AttributeField>(fields: readonly F[]): F | null {
  if (fields.length === 0) return null;
  const type = storageType(fields[0].type);
  return fields.every((f) => storageType(f.type) === type) ? fields[0] : null;
}

/** The storage type of a free-form value no writer typed: number, date or
 *  bool when the value, exactly as stored, is one ("42", "2026-10-16",
 *  "true"), else text. Not trimmed: " 5 " is text, because typed reads (the
 *  SQL guards) would not see it as a number — a writer that wants the number
 *  stores "5" (the collection table trims typed cells). */
export function freeFormType(raw: string): AttributeValueType {
  for (const type of ["number", "date", "bool"] as const) if (fitsType(type, raw)) return type;
  return "text";
}

/** Whether `raw` is a value of storage type `type` — what typed reads may
 *  cast. A hint the value does not fit is not trusted. */
function fitsType(type: AttributeValueType, raw: string): boolean {
  switch (type) {
    case "number": return NUMBER_RE.test(raw);
    case "date":   return isCalendarDate(raw);
    case "bool":   return raw === "true" || raw === "false";
    default:       return raw !== "" || type === "text";
  }
}

/** The value_type a non-empty value of a `fieldType` field is stored under:
 *  the field's storage type, except a list (D117), which is text — typed reads
 *  take numbers and dates only from rows of that type — and a relation list,
 *  which stays node_ref (its elements are note ids). */
function storedType(fieldType: string | undefined, raw: string): AttributeValueType {
  const type = storageType(fieldType);
  return type !== "node_ref" && isListValue(raw) ? "text" : type;
}

/** The stored form of `raw` for a key governed by `field` (null/undefined =
 *  a free-form key). A governed value gets its field's storage type — `hint`
 *  (what the writer believed) is used only for a free-form key, and only when
 *  the value fits it; otherwise the key falls back to freeFormType(raw). An empty value is text: there is nothing to
 *  type. The value string itself is stored as given. */
export function normalize(
  field: AttributeField | null | undefined,
  raw: string,
  hint?: AttributeValueType,
): NormalizedAttributeValue {
  if (!field) return { ok: true, value: raw, value_type: hint && fitsType(hint, raw) ? hint : freeFormType(raw) };
  const reason = fieldViolation(field, raw);
  if (reason) return { ok: false, reason };
  return { ok: true, value: raw, value_type: raw === "" ? "text" : storedType(field.type, raw) };
}

/** The field type a new key gets from its first value. We never ask the user
 *  to declare a type: a number reads as a number, a real calendar date as a
 *  date, true/false as a boolean, and anything ambiguous stays text. */
export function inferFieldType(raw: string): "number" | "date" | "boolean" | "text" {
  const v = raw.trim();
  if (v === "") return "text";
  if (NUMBER_RE.test(v)) return "number";
  if (isCalendarDate(v)) return "date";
  if (v === "true" || v === "false") return "boolean";
  return "text";
}

/** The storage type of a JS value with no governing field, chosen so
 *  parseValue(serializeValue(v), type) gives `v` back: numbers and booleans
 *  keep their type, a string is a date when it is a calendar date and text
 *  otherwise ("42" stays the string "42"). For text a person typed into a new
 *  key, use storageType(inferFieldType(raw)) instead. */
export function inferFromValue(value: unknown): AttributeValueType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "string" && isCalendarDate(value)) return "date";
  return "text";
}

/** A JS value as the stored string ("" for null; objects as JSON). */
export function serializeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/** A stored string back as a JS value of `valueType` ("" → null; a number
 *  that does not parse → null; other types stay strings). */
export function parseValue(value: string, valueType: string): unknown {
  if (value === "") return null;
  switch (valueType) {
    case "number": { const n = Number(value); return Number.isNaN(n) ? null : n; }
    case "bool":   return value === "true" || value === "1";
    default:       return value;
  }
}

/** The value_type a value of a key is stored under, for a reader that holds
 *  the value but not its node_attributes row (the app's notes carry a flat
 *  `attrs` map): `fields` are the schema fields declaring the key on the
 *  note's tags. The governing field's storage type when there is one (what
 *  normalize stored), else freeFormType(raw) — a free-form value's writer
 *  hint is not known here; a hint the value fits names the same type, except
 *  a value a writer typed as text on purpose. An empty value is text. */
export function storedValueType(raw: string, fields: readonly AttributeField[]): AttributeValueType {
  if (raw === "") return "text";
  const field = governingField(fields);
  return field ? storedType(field.type, raw) : freeFormType(raw);
}

/** The comparison operators of a filter on an attribute value. */
export type AttributeComparison = "==" | "!=" | ">" | ">=" | "<" | "<=";

/** Whether a stored value is a date to typed reads: value_type 'date' and a
 *  calendar date (undefined type: the grammar alone decides, as for numbers). */
function isStoredDate(value: string, valueType?: string): boolean {
  return (valueType === undefined || valueType === "date") && isCalendarDate(value);
}

const DATE_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-])(\d{2}):?(\d{2}))?)?$/;

/** The instant a calendar date names, in ms. A date without a zone reads as
 *  UTC: the server reads it in its session zone — the same for both sides of
 *  a comparison, so zoneless values compare alike either way. */
function dateInstant(s: string): number {
  const m = DATE_PARTS_RE.exec(s)!;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0),
    Number(m[6] ?? 0), m[7] ? Math.round(Number(m[7]) * 1000) : 0);
  const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60_000 : 0;
  return utc - offset;
}

/** Whether a stored attribute value (null/undefined = the note has none)
 *  passes `value <op> rhs`, typed as the server's filters read it (backend
 *  services/filter/sqlClauses.ts). `rhs` is a number (an unquoted literal)
 *  or a string.
 *   - ==, != : the value as stored equals the rhs's text, exactly as the
 *     server's eq compares (so 5 equals "5", not "5.0"); a list value equals
 *     the text of any one of its elements (D117). A missing value
 *     equals nothing, so != keeps it (the server's NOT EXISTS).
 *   - ranges : by the rhs's grammar, as the SQL picks its arm — a number
 *     (NUMBER_PATTERN, quoted or not) compares stored numbers, a calendar date
 *     compares stored dates as instants; any other rhs, a value of another
 *     type or a missing value matches nothing ("10" and "9" never compare as
 *     text). */
export function compareAttribute(
  value: string | null | undefined, valueType: string | undefined, op: AttributeComparison, rhs: string | number,
): boolean {
  if (op === "==" || op === "!=") {
    const text = String(rhs);
    const eq = value != null && (value === text || (listItems(value)?.includes(text) ?? false));
    return op === "==" ? eq : !eq;
  }
  if (value == null) return false;
  let sign: number;
  if (typeof rhs === "number" || NUMBER_RE.test(rhs)) {
    const n = storedNumber(value, valueType);
    if (n === null) return false;
    sign = Math.sign(n - Number(rhs));
  } else if (isCalendarDate(rhs)) {
    if (!isStoredDate(value, valueType)) return false;
    sign = Math.sign(dateInstant(value) - dateInstant(rhs));
  } else {
    return false;
  }
  switch (op) {
    case ">":  return sign > 0;
    case ">=": return sign >= 0;
    case "<":  return sign < 0;
    case "<=": return sign <= 0;
  }
}

/** One key of the server's attribute sort: present values in `dir` order,
 *  absent ones (null) last whatever the direction (NULLS LAST). */
function keyOrder<T extends number | string>(a: T | null, b: T | null, dir: "asc" | "desc"): number {
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
  const order = a < b ? -1 : a > b ? 1 : 0;
  return dir === "desc" ? -order : order;
}

/** The order of two stored values (null/undefined = none) in a sort by their
 *  attribute — the server's attributeSortSql (backend collectionViewQuery.ts):
 *  stored numbers by value (9 before 10), then stored dates as ISO text, then
 *  the raw text; each key puts the values it does not read last, so a note
 *  without the attribute sorts last in both directions. The raw text compares
 *  by code point (the server by its collation). */
export function compareAttributeOrder(
  a: string | null | undefined, aType: string | undefined,
  b: string | null | undefined, bType: string | undefined,
  dir: "asc" | "desc" = "asc",
): number {
  return keyOrder(storedNumber(a, aType), storedNumber(b, bType), dir)
    || keyOrder(a != null && isStoredDate(a, aType) ? a : null, b != null && isStoredDate(b, bType) ? b : null, dir)
    || keyOrder(a ?? null, b ?? null, dir);
}
