// fast-check generators for the round-trip tests (test/properties/*RoundTrip*):
// a realistic workspace as plain data (a `WorldSpec`), with no database and no
// ids. helpers/roundTripWorld.ts builds it into Postgres and reads it back.
//
// "Realistic" means what people write: Chinese and English titles with
// punctuation and slashes, bodies that mix prose, headings, lists, tasks, code
// fences, math, images, wikilinks, block references and embeds. Text that
// would be *syntax* by accident (a leading `#`, `---`, `{tags}`, `key:: v`) is
// kept out of plain words, so a failure means a real loss and not a note that
// accidentally became something else.

import fc from "fast-check";
import { encodeValues } from "@onden/markdown";
import { PROPS_SEED } from "./propsConfig.js";
import { pdfInkSim } from "./pdfInkEnvelope.js";
import { richSpec, withoutTrashed, type RichSpec } from "./roundTripRichSpec.js";

// ── Text ─────────────────────────────────────────────────────────────────────

/** `arb` in about `percent` of the cases, null otherwise. */
const sometimes = <T>(arb: fc.Arbitrary<T>, percent: number): fc.Arbitrary<T | null> =>
  fc.oneof({ arbitrary: fc.constant(null), weight: 100 - percent }, { arbitrary: arb, weight: percent });

const LATIN = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const CJK = [..."筆記資料結構演算法考試複習作業專案計畫會議閱讀心得日本語한글"];
const ACCENTED = ["é", "ü", "ñ", "ø", "ß"];
const EMOJI = ["😀", "🦊", "✍️", "🇹🇼", "👩‍👩‍👧"];
const PLAIN_PUNCT = [".", ",", ";", "!", "?", "'", '"', "(", ")", "&", "-", "+", "=", "~", "%", "，", "。", "：", "！"];
// Characters a title may carry that a file name or a link must survive: path
// separators, colons, quotes, brackets, `#`, `|`.
const TITLE_ODD = ["/", ":", '"', "?", "*", "|", "#", "\\", "[", "]", "..", "&", "'", "<", ">", "。", "（", "）"];

/** A word of prose: no character that is Markdown or Onden syntax on its own. */
export const word = fc.array(fc.oneof(
  { arbitrary: fc.constantFrom(...LATIN), weight: 6 },
  { arbitrary: fc.constantFrom(...CJK), weight: 4 },
  { arbitrary: fc.constantFrom(...ACCENTED), weight: 1 },
  { arbitrary: fc.constantFrom(...EMOJI), weight: 1 },
), { minLength: 1, maxLength: 7 }).map((chars) => chars.join(""));

/** A line of prose: words, some followed by punctuation. Starts with a word. */
const sentence = fc.array(fc.tuple(word, sometimes(fc.constantFrom(...PLAIN_PUNCT), 25)), { minLength: 1, maxLength: 8 })
  .map((parts) => parts.map(([w, p]) => `${w}${p ?? ""}`).join(" "));

/** A note title: one to three words, sometimes with a separator-like character
 *  in the middle ("A/B", "Q&A: 第2章", "C# 筆記"). Never starts or ends blank. */
export const titleText = fc.tuple(
  fc.array(word, { minLength: 1, maxLength: 3 }),
  sometimes(fc.constantFrom(...TITLE_ODD), 35),
).map(([words, odd]) => (odd ? `${words[0]}${odd}${words.slice(1).join(" ") || "x"}` : words.join(" ")));

// ── Bodies ───────────────────────────────────────────────────────────────────

/** A block of a body. `link` / `embed` / `blockLink` name another note by its
 *  index in the world (the builder turns the index into a title or an id). */
export type BlockSpec =
  | { kind: "paragraph"; text: string; ref: string | null; /** An Onden block tag `{name}` at its end. */ tag?: string | null }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "task"; text: string; done: boolean }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "math"; display: boolean; formula: string }
  | { kind: "image"; alt: string; n: number }
  | { kind: "quote"; text: string }
  | { kind: "link"; target: number; alias: string | null; via: "wikilink" | "node" }
  | { kind: "embed"; target: number }
  | { kind: "blockLink"; target: number };

const CODE_LINES = ["const a = 1;", "# not a heading", "---", "[[not a link]]", "if (x < y && y > 0) {", "  return `t${x}`;", "}", "print('字')", "$ echo \"$HOME\"", "| a | b |"];
const FORMULAS = ["E = mc^2", "\\frac{a}{b} + x_{1}", "\\sum_{i=1}^{n} i", "a+b", "\\int_0^1 f(x)\\,dx"];
const BLOCK_REF = fc.stringMatching(/^[a-z][a-z0-9]{3,7}$/);


export const blockSpec = (noteCount: number, options: { blockTags?: boolean } = {}): fc.Arbitrary<BlockSpec> => {
  const target = fc.nat({ max: Math.max(0, noteCount - 1) });
  const common: Array<{ arbitrary: fc.Arbitrary<BlockSpec>; weight: number }> = [
    { arbitrary: fc.record({ kind: fc.constant("paragraph" as const), text: sentence, ref: sometimes(BLOCK_REF, 30), tag: options.blockTags ? sometimes(fc.constantFrom("idea", "題目", "q-1"), 40) : fc.constant(null) }), weight: 8 },
    { arbitrary: fc.record({ kind: fc.constant("heading" as const), level: fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>, text: sentence }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("list" as const), items: fc.array(sentence, { minLength: 1, maxLength: 3 }), ordered: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ kind: fc.constant("task" as const), text: sentence, done: fc.boolean() }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("code" as const), lang: fc.constantFrom("", "ts", "py", "sh"), lines: fc.array(fc.constantFrom(...CODE_LINES), { minLength: 1, maxLength: 4 }) }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("math" as const), display: fc.boolean(), formula: fc.constantFrom(...FORMULAS) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("image" as const), alt: word, n: fc.nat({ max: 3 }) }), weight: 1 },
    { arbitrary: fc.record({ kind: fc.constant("quote" as const), text: sentence }), weight: 1 },
  ];
  if (noteCount > 1) {
    common.push(
      { arbitrary: fc.record({ kind: fc.constant("link" as const), target, alias: sometimes(word, 60), via: fc.constantFrom("wikilink" as const, "node" as const) }), weight: 3 },
      { arbitrary: fc.record({ kind: fc.constant("embed" as const), target }), weight: 1 },
      { arbitrary: fc.record({ kind: fc.constant("blockLink" as const), target }), weight: 1 },
    );
  }
  return fc.oneof(...common);
};

// ── Attributes ───────────────────────────────────────────────────────────────

/** The attribute keys the app itself offers: they pass the key grammar. */
const STANDARD_KEYS = ["rating", "status", "author", "url", "due", "topics", "作者", "進度", "source_note"];
/** Keys outside the grammar that Onden still stores (a CSV column such as
 *  "Due Date", a colon, an emoji): export drops them (review #10). */
const EXOTIC_KEYS = ["Due Date", "Release: Date", "⭐ rating", "a b c", "備註 說明"];

export type AttrSpec = { key: string; value: string; valueType: "text" | "number" | "date" | "bool" };

const plainValue = fc.oneof(sentence, word);
const standardAttr: fc.Arbitrary<AttrSpec> = fc.oneof(
  fc.record({ key: fc.constantFrom("status", "author", "作者", "進度", "source_note"), value: plainValue, valueType: fc.constant("text" as const) }),
  fc.record({ key: fc.constant("rating"), value: fc.integer({ min: 1, max: 5 }).map(String), valueType: fc.constant("number" as const) }),
  fc.record({ key: fc.constant("url"), value: word.map((w) => `https://example.com/${encodeURIComponent(w)}`), valueType: fc.constant("text" as const) }),
  fc.record({ key: fc.constant("due"), value: fc.date({ min: new Date("2024-01-01"), max: new Date("2030-12-31"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)), valueType: fc.constant("date" as const) }),
  // A list value: the one multi-value codec (@onden/markdown encodeValues).
  fc.record({ key: fc.constant("topics"), value: fc.array(word, { minLength: 2, maxLength: 4 }).map((w) => encodeValues(w)), valueType: fc.constant("text" as const) }),
);

/** An attribute whose key is outside the key grammar (a CSV column). */
export const oddKeyAttr: fc.Arbitrary<AttrSpec> =
  fc.record({ key: fc.constantFrom(...EXOTIC_KEYS), value: plainValue, valueType: fc.constant("text" as const) });

/** An attribute whose value spans lines. */
export const multilineAttr: fc.Arbitrary<AttrSpec> = fc.record({
  key: fc.constantFrom("status", "author", "備註"),
  value: fc.array(sentence, { minLength: 2, maxLength: 3 }).map((lines) => lines.join("\n")),
  valueType: fc.constant("text" as const),
});

/** One attribute outside the Markdown export's reach: an odd key, or a multi-line value. */
export const exoticAttr: fc.Arbitrary<AttrSpec> = fc.oneof(oddKeyAttr, multilineAttr);

export const standardAttrs: fc.Arbitrary<AttrSpec[]> = fc.array(standardAttr, { maxLength: 4 })
  .map((attrs) => [...new Map(attrs.map((a) => [a.key, a])).values()]);

// ── The world ────────────────────────────────────────────────────────────────

export type TagSpec = {
  name: string;
  /** Index of an earlier tag, or null for a root tag. */
  parent: number | null;
  /** A tag with functions: a field schema (and a description) on it. */
  functions: boolean;
};

export type NoteSpec = {
  title: string;
  /** Index of an earlier note, or null. */
  parent: number | null;
  blocks: BlockSpec[];
  /** Indices into `tags`. */
  tags: number[];
  attrs: AttrSpec[];
  trashed: boolean;
  /** A real stored media file linked from the body. */
  media: boolean;
};

/** A task with no host note (T1's standalone task): the fields the Markdown
 *  task list and the backup must carry. `whenKey` is the key "何時做" is
 *  stored under (`_task_due` before T1, `_task_when` after). */
export type StandaloneTaskSpec = {
  title: string;
  status: "todo" | "doing" | "done" | "cancelled" | "waiting" | "later";
  when: string | null;
  whenKey: "_task_when" | "_task_due";
  deadline: string | null;
  recur: string | null;
  recurMode: string | null;
  evening: boolean;
  someday: boolean;
  remindAt: string | null;
  /** Its body text (paragraphs), or none. */
  body: string[];
  trashed: boolean;
};

export type WorldSpec = {
  tags: TagSpec[];
  notes: NoteSpec[];
  /** Standalone tasks, when the world has any. */
  tasks?: StandaloneTaskSpec[];
  /** Notes (indices) placed on the world's one canvas, or null for none. */
  canvas: { title: string; cards: number[] } | null;
  /** What a person would miss after a restore and a plain world has none of: saved views, tag functions, pointers,
   *  paragraph tags… (roundTripRichSpec.ts). Present when `rich` is asked for. */
  rich?: RichSpec;
};

export type WorldOptions = {
  maxNotes?: number;
  /** Soft-delete some notes. */
  trashed?: boolean;
  /** Give some notes an attribute outside the Markdown export's reach: an odd
   *  key and/or a multi-line value ("values": only the latter). */
  exotic?: boolean | "values";
  /** Give some notes a drawing (`ink_data`) over the chunk threshold (services/inkChunks.ts): for the trips that carry a
   *  note's attributes whole (a backup, a move); the Markdown export does not carry a drawing. */
  bigInk?: boolean;
  canvas?: boolean;
  tagFunctions?: boolean;
  media?: boolean;
  /** Let live notes link to notes that are in the trash (default: they don't). */
  linksToTrashed?: boolean;
  /** Add standalone tasks (up to this many; `true` = 5). */
  standaloneTasks?: boolean | number;
  /** Add the rich part (roundTripRichSpec.ts) and let paragraphs carry `{tag}`s. */
  rich?: boolean;
};

const day = fc.date({ min: new Date("2024-01-01"), max: new Date("2030-12-31"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));

const standaloneTask: fc.Arbitrary<StandaloneTaskSpec> = fc.record({
  title: titleText,
  status: fc.constantFrom("todo", "todo", "doing", "done", "cancelled", "waiting", "later") as fc.Arbitrary<StandaloneTaskSpec["status"]>,
  when: sometimes(day, 60),
  whenKey: fc.constantFrom("_task_when", "_task_when", "_task_due") as fc.Arbitrary<StandaloneTaskSpec["whenKey"]>,
  deadline: sometimes(day, 40),
  recur: sometimes(fc.constantFrom("1d", "2d", "1w", "3w", "1m", "2m"), 30),
  recurMode: sometimes(fc.constantFrom("fixed", "after_done"), 20),
  evening: fc.boolean(),
  someday: fc.boolean(),
  remindAt: sometimes(fc.tuple(day, fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 15, 30, 45)).map(([d, h, m]) => `${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`), 25),
  body: fc.array(sentence, { maxLength: 3 }),
  trashed: fc.integer({ min: 0, max: 99 }).map((n) => n < 20),
});

const tagName = fc.tuple(word, fc.boolean()).map(([w, long]) => (long ? `${w} ${[...w].slice(0, 2).join("")}x` : w));

/** Case-insensitive, NFC-folded identity of a title: two notes may not share it. */
export const titleIdentity = (title: string) => title.normalize("NFC").trim().toLowerCase();

export function worldSpec(options: WorldOptions = {}): fc.Arbitrary<WorldSpec> {
  const maxNotes = options.maxNotes ?? 7;
  const tags = fc.array(fc.record({ name: tagName, parentRoll: fc.nat({ max: 99 }), functions: options.tagFunctions ? fc.boolean() : fc.constant(false) }), { maxLength: 5 })
    .map((raw): TagSpec[] => {
      // Siblings are unique by name; a parent is always an earlier tag.
      const out: TagSpec[] = [];
      const seen = new Set<string>();
      for (const t of raw) {
        const parent = out.length > 0 && t.parentRoll < 55 ? t.parentRoll % out.length : null;
        const key = `${parent}|${titleIdentity(t.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: t.name, parent, functions: t.functions });
      }
      return out;
    });

  return tags.chain((tagList) => fc.integer({ min: 1, max: maxNotes }).chain((count) => fc.record({
    notes: fc.array(fc.record({
      title: titleText,
      parentRoll: fc.nat({ max: 99 }),
      blockCount: fc.integer({ min: 0, max: 6 }),
      tagRolls: fc.array(fc.nat({ max: Math.max(0, tagList.length - 1) }), { maxLength: tagList.length === 0 ? 0 : 3 }),
      attrs: standardAttrs,
      exotic: options.exotic ? sometimes(options.exotic === "values" ? multilineAttr : exoticAttr, 60) : fc.constant(null),
      trashRoll: fc.nat({ max: 99 }),
      media: options.media ? fc.boolean() : fc.constant(false),
    }), { minLength: count, maxLength: count }).chain((raw) => fc.tuple(...raw.map((r) => fc.array(blockSpec(count, { blockTags: options.rich }), { minLength: r.blockCount, maxLength: r.blockCount }))).map((blocks) => ({ raw, blocks }))),
    canvasRoll: fc.array(fc.nat({ max: Math.max(0, count - 1) }), { maxLength: 4 }),
    canvasTitle: titleText,
    rich: options.rich ? richSpec(count, tagList.length) : fc.constant(null),
    taskList: options.standaloneTasks ? fc.array(standaloneTask, { minLength: 1, maxLength: options.standaloneTasks === true ? 5 : options.standaloneTasks }) : fc.constant([] as StandaloneTaskSpec[]),
  }).map(({ notes: { raw, blocks }, canvasRoll, canvasTitle, taskList, rich }): WorldSpec => {
    const seen = new Set<string>();
    const notes: NoteSpec[] = [];
    raw.forEach((r, i) => {
      // Globally unique titles keep every [[link]] unambiguous.
      let title = r.title;
      while (seen.has(titleIdentity(title))) title = `${title}${i}`;
      seen.add(titleIdentity(title));
      const parent = i > 0 && r.parentRoll < 45 ? r.parentRoll % i : null;
      const trashed = options.trashed ? r.trashRoll < 25 : false;
      // A drawing over the chunk threshold (services/inkChunks.ts): every trip must bring the whole value back, byte for byte.
      const ink: AttrSpec[] = options.bigInk && r.trashRoll % 6 === 0 ? [{ key: "ink_data", value: bigInkValue(i + r.trashRoll), valueType: "text" }] : [];
      const attrs = [...r.attrs, ...(r.exotic ? [r.exotic] : []), ...ink];
      notes.push({
        title, parent, blocks: blocks[i]!,
        tags: [...new Set(r.tagRolls)], attrs: [...new Map(attrs.map((a) => [a.key, a])).values()],
        trashed, media: r.media,
      });
    });
    // A trashed note takes its subtree with it (the tree stays whole, D111).
    for (let i = 0; i < notes.length; i++) {
      const parent = notes[i]!.parent;
      if (parent !== null && notes[parent]!.trashed) notes[i]!.trashed = true;
    }
    if (!options.linksToTrashed) {
      for (const note of notes) {
        if (note.trashed) continue;
        note.blocks = note.blocks.map((b): BlockSpec => ("target" in b && notes[b.target]!.trashed ? { kind: "paragraph", text: "plain text", ref: null } : b));
      }
    }
    // Task titles are unique among tasks, so a task is named by its title.
    const taskTitles = new Set<string>();
    const tasks = taskList.map((t, i): StandaloneTaskSpec => {
      let title = t.title;
      while (taskTitles.has(titleIdentity(title))) title = `${title}${i}`;
      taskTitles.add(titleIdentity(title));
      return { ...t, title, trashed: options.trashed ? t.trashed : false };
    });
    return {
      tags: tagList,
      notes,
      ...(tasks.length ? { tasks } : {}),
      ...(rich ? { rich: withoutTrashed(rich, notes.map((n) => n.trashed)) } : {}),
      canvas: options.canvas ? { title: `${canvasTitle} board`, cards: [...new Set(canvasRoll)] } : null,
    };
  })));
}

/** A PDF drawing envelope of more than INK_CHUNK_THRESHOLD characters, the same for the same seed. */
function bigInkValue(seed: number): string {
  const sim = pdfInkSim({ seed: seed + 1, pages: 4 });
  sim.drawStrokes(40);
  return sim.value();
}

export const EXOTIC_ATTRIBUTE_KEYS: readonly string[] = EXOTIC_KEYS;
export const STANDARD_ATTRIBUTE_KEYS: readonly string[] = STANDARD_KEYS;

// ── Seeds ────────────────────────────────────────────────────────────────────

/** fast-check settings for the round-trip properties. The seed is PROPS_SEED
 *  (a fresh one on every run unless set) or `ROUNDTRIP_SEED=<n>`, and a failure
 *  prints the seed and the shrunk world to replay it with. A trip builds, exports and imports
 *  whole workspaces, so the run count is small (`maxRuns`, default 8):
 *  `ROUNDTRIP_RUNS=<n>` raises it. */
export function roundTripRuns(overrides: { maxRuns?: number } = {}): { seed: number; numRuns: number; endOnFailure: boolean } {
  const seed = Number(process.env.ROUNDTRIP_SEED ?? PROPS_SEED);
  const numRuns = Number(process.env.ROUNDTRIP_RUNS ?? overrides.maxRuns ?? 8);
  // A failing trip is slow to shrink (each step builds a workspace): report the
  // first failing world unless asked to shrink.
  return { seed, numRuns, endOnFailure: process.env.ROUNDTRIP_SHRINK !== "1" };
}
