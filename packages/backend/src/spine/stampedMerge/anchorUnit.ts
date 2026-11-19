// An anchor's place as the merge core takes it, and the ONE check every value from the outside goes through: a note's anchors unit (parseAnchorUnit, used by the
// received-row check of dbUnits.ts, by chooseAnchorHead below and by body.ts anchorsOfVersion) and a fact a caller passes (usableFact, body.ts mergeAnchors). A value that fails is not an anchor of any
// version: it is left out with a reason, never thrown on, never guessed at (review of PR #1853, point 5).
import { BLOCK_ID, NODE_MARKDOWN_MAX } from "@onden/markdown";
import { type Unit, compareStamps } from "./unit.js";

/** One anchor as a body version holds it: what its note's anchors unit says of it, with its id. Positions are UTF-16 offsets into that version's text. */
export type AnchorFact = {
  anchorId: string;
  status: "valid" | "maybe" | "lost";
  /** where it stands; 0..0 for an anchor that is not valid (services/blockAnchors/mapping.ts NO_POSITION) */
  from: number; to: number;
  candidate: { from: number; to: number } | null;
  quote: string; prefix: string; suffix: string;
  recoveryPending: boolean;
};
const STATUSES: ReadonlySet<string> = new Set(["valid", "maybe", "lost"]);
const BODY_HASH = /^[0-9a-f]{64}$/;
/** A UTF-16 offset into a note's body: no body is longer than NODE_MARKDOWN_MAX, so no place stands past it, whatever body it was measured on (a place carrying its own
 *  body hash names a body this node may not hold; this bound is what keeps it inside the database's int column: review of PR #1853, round 4, point 1). */
const offset = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= NODE_MARKDOWN_MAX;
const span = (from: unknown, to: unknown): boolean => offset(from) && offset(to) && from <= to;

/** An anchor this file can work with, or why not: the ONE check every value from the outside goes through (`parseAnchorUnit` for a note's anchors unit, `usableFact` for a
 *  fact a caller passes). A value that fails is not an anchor of any version: it is left out, never thrown on, never guessed at. */
type PlaceCheck = { ok: true; fact: AnchorFact } | { ok: false; reason: string };
function checkFields(anchorId: unknown, v: Record<string, unknown>, keys: { from: string; to: string; cFrom: string; cTo: string; quote: string; prefix: string; suffix: string; pending: string }): PlaceCheck {
  if (typeof anchorId !== "string" || !BLOCK_ID.test(anchorId)) return { ok: false, reason: "anchor id" };
  const status = v.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return { ok: false, reason: "status" };
  if (!span(v[keys.from], v[keys.to])) return { ok: false, reason: "position" };
  const cf = v[keys.cFrom], ct = v[keys.cTo];
  if (!((cf === null && ct === null) || span(cf, ct))) return { ok: false, reason: "candidate" };
  for (const k of [keys.quote, keys.prefix, keys.suffix]) if (typeof v[k] !== "string") return { ok: false, reason: k };
  if (typeof v[keys.pending] !== "boolean") return { ok: false, reason: "pending" };
  return {
    ok: true,
    fact: { anchorId, status: status as AnchorFact["status"], from: v[keys.from] as number, to: v[keys.to] as number, candidate: cf === null ? null : { from: cf as number, to: ct as number },
      quote: v[keys.quote] as string, prefix: v[keys.prefix] as string, suffix: v[keys.suffix] as string, recoveryPending: v[keys.pending] as boolean },
  };
}
/** A fact as a caller passes it, checked the same way (and copied: the answer never shares an object with the input). */
export function usableFact(a: unknown): AnchorFact | null {
  if (a === null || typeof a !== "object") return null;
  const v = a as Record<string, unknown>;
  const cand = v.candidate;
  const flat = { ...v, cf: cand === null ? null : (cand as { from?: unknown } | undefined)?.from, ct: cand === null ? null : (cand as { to?: unknown } | undefined)?.to };
  if (cand !== null && (cand === undefined || typeof cand !== "object")) return null;
  const r = checkFields(v.anchorId, flat, { from: "from", to: "to", cFrom: "cf", cTo: "ct", quote: "quote", prefix: "prefix", suffix: "suffix", pending: "recoveryPending" });
  return r.ok ? r.fact : null;
}

/** A note's anchors unit (note_anchor_places.places, migration 215): the body hash it was measured on and each anchor's place; an anchor whose own hash is not the
 *  unit's (a row left stale before 215) carries it (`ownHash`). The one reader of the unit's text: the received-row check, the expansion and body.ts use it. */
type AnchorUnit = { hash: string; anchors: Array<AnchorFact & { ownHash: string | null }> };
/** The largest unit a node takes, in bytes of its text (UTF-8: the text jsonb writes, so the database measures the same, migration 215 anchor_unit_bytes_max, which a
 *  test compares with this). A writer never writes a larger one: it gives up anchors' words first, the oldest lost ones first (note_anchor_places_write; review of
 *  PR #1853, round 4, point 3). */
const ANCHOR_UNIT_BYTES_MAX = 16_000_000;
const utf8 = new TextEncoder();
const quoted = (s: string) => JSON.stringify(s);
/** The text of a unit as the writer's database writes it (jsonb's own text form, migration 215 note_anchor_places_of): keys by length and then bytes, ", " and ": " between,
 *  whole numbers in decimal. A received unit whose text is not this is refused: two texts of one unit would be two different units to the merge, and a text the database
 *  would read differently (a number written `1.0`) would not be the value the sender meant. */
function anchorUnitText(unit: AnchorUnit): string {
  const byKey = (x: string, y: string) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
  const entries = [...unit.anchors].sort((x, y) => byKey(x.anchorId, y.anchorId)).map((f) => {
    const e: unknown[] = [f.from, f.to, f.status, f.candidate?.from ?? null, f.candidate?.to ?? null, f.recoveryPending, f.quote, f.prefix, f.suffix];
    if (f.ownHash !== null) e.push(f.ownHash);
    return `${quoted(f.anchorId)}: [${e.map((v) => JSON.stringify(v)).join(", ")}]`;
  });
  return `{"a": {${entries.join(", ")}}, "h": ${quoted(unit.hash)}}`;
}
/** A text the database holds as it was sent: no NUL (jsonb refuses \u0000) and no lone surrogate (not UTF-8). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const storable = (t: string) => !t.includes("\u0000") && !LONE_SURROGATE.test(t);
export function parseAnchorUnit(text: unknown): { ok: true; unit: AnchorUnit } | { ok: false; reason: string } {
  if (typeof text !== "string") return { ok: false, reason: "not a text" };
  // a UTF-16 unit is at most 3 bytes: a text that short is under the bound without counting its bytes
  if (text.length * 3 > ANCHOR_UNIT_BYTES_MAX && utf8.encode(text).length > ANCHOR_UNIT_BYTES_MAX) return { ok: false, reason: "larger than a unit may be" };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, reason: "not JSON" }; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "not an object" };
  if (Object.keys(v).sort().join(",") !== "a,h") return { ok: false, reason: "keys" };
  const { h, a } = v as { h?: unknown; a?: unknown };
  if (typeof h !== "string" || !BODY_HASH.test(h)) return { ok: false, reason: "body hash" };
  if (a === null || typeof a !== "object" || Array.isArray(a)) return { ok: false, reason: "anchors" };
  const anchors: AnchorUnit["anchors"] = [];
  for (const [id, entry] of Object.entries(a as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!Array.isArray(entry) || (entry.length !== 9 && entry.length !== 10)) return { ok: false, reason: "an anchor's entry" };
    const [from, to, status, cf, ct, pending, quote, prefix, suffix, own] = entry as unknown[];
    const r = checkFields(id, { from, to, status, cf, ct, pending, quote, prefix, suffix }, { from: "from", to: "to", cFrom: "cf", cTo: "ct", quote: "quote", prefix: "prefix", suffix: "suffix", pending: "pending" });
    if (!r.ok) return r;
    if (![r.fact.quote, r.fact.prefix, r.fact.suffix].every(storable)) return { ok: false, reason: "a text the database cannot hold" };
    // a writer adds its own hash only when it is not the unit's (migration 215 note_anchor_places_of): one place, one way to write it
    if (entry.length === 10 && (typeof own !== "string" || !BODY_HASH.test(own) || own === h)) return { ok: false, reason: "an anchor's own body hash" };
    // an anchor measured on the unit's body was written by this version of the code (services/blockAnchors/mapping.ts): only a valid anchor stands somewhere, and it
    // has no candidate and is not waiting to be looked up. An anchor with its own hash is a row left as it was before 215 and is taken as it is.
    if (entry.length === 9 && (r.fact.status === "valid" ? r.fact.candidate !== null || r.fact.recoveryPending : r.fact.from !== 0 || r.fact.to !== 0)) {
      return { ok: false, reason: "status and position" };
    }
    anchors.push({ ...r.fact, ownHash: entry.length === 10 ? (own as string) : null });
  }
  // a writer removes a note's unit when the note has no anchor (migration 215 note_anchor_places_write): an empty one is not a writer's
  if (anchors.length === 0) return { ok: false, reason: "no anchors" };
  const unit = { hash: h, anchors };
  if (anchorUnitText(unit) !== text) return { ok: false, reason: "not written as the database writes it" };
  return { ok: true, unit };
}

type UsableHead = { text: string; unit: AnchorUnit; stamp: Unit[number]["stamp"] };
/** The usable heads of a note's anchors unit (parseAnchorUnit), newest first (stamp, then text: the same order on every node). */
function usableHeads(unit: Unit): UsableHead[] {
  return unit.filter((c) => !c.deleted).flatMap((c) => { const p = parseAnchorUnit(c.value); return p.ok ? [{ text: c.value as string, unit: p.unit, stamp: c.stamp }] : []; })
    .sort((x, y) => compareStamps(y.stamp, x.stamp) || (x.text < y.text ? -1 : x.text > y.text ? 1 : 0));
}
/** Every place of a head stands inside a body of `length` UTF-16 units (a head received while this node did not hold its body was not bounded then). */
const fits = (u: AnchorUnit, length: number) => u.anchors.every((f) => f.ownHash !== null || (f.to <= length && (f.candidate === null || f.candidate.to <= length)));

/** What the anchor rows of a note are made from (migration 215 note_anchor_places_expand_all), a pure function of the note's anchors unit (every head) and its stored body:
 *  - `text`: the head that goes with the body whose sha-256 is `bodyHash`: a usable head measured on that body whose places fit in it, the newest when several are. That head
 *    is the whole set of anchors one write left with that body; a head of another body never shows with this one (a write whose body lost, or a write of places only whose
 *    body is not the one stored: review of PR #1853, rounds 2 and 3). None: null, and every anchor row of the note is `lost`, standing nowhere.
 *  - `hash`: the body the rows are measured on: the chosen head's, or with none the newest usable head's (another body than the stored one, so the next save looks them up).
 *  - `words`: for an anchor the chosen head does not name, its quote and context from the newest head that names it (not this node's row: which bundle came first is not
 *    replicated). An anchor no head names has no words (what its row held is history: an earlier expansion's words, or a sender's row as it stood).
 *  No usable head at all: `hash` null, and the rows are left as they are. */
export function chooseAnchorHead(unit: Unit, bodyHash: string, bodyLength: number): { text: string | null; hash: string | null; words: Record<string, [string, string, string]> } {
  const heads = usableHeads(unit);
  const here = heads.find((x) => x.unit.hash === bodyHash && fits(x.unit, bodyLength));
  const words: Record<string, [string, string, string]> = {};
  const named = new Set(here?.unit.anchors.map((f) => f.anchorId) ?? []);
  for (const x of heads) for (const f of x.unit.anchors) if (!named.has(f.anchorId) && !(f.anchorId in words)) words[f.anchorId] = [f.quote, f.prefix, f.suffix];
  return here ? { text: here.text, hash: here.unit.hash, words } : { text: null, hash: heads[0]?.unit.hash ?? null, words };
}
