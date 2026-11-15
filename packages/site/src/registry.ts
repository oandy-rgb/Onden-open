// The component registry as data (design doc §5.1): which components exist,
// their slots and the props each may carry. The validator, the Puck config and
// the render components all read it, so none of them keeps its own list.

export const PART_TYPES = ["stack", "sidebar", "switcher", "cards", "cover", "center"] as const;
export const CONTENT_TYPES = ["note", "tag_view", "timeline"] as const;
export const PATTERN_TYPES = ["pattern_intro_now", "pattern_work_cards", "pattern_three_entries", "pattern_timeline"] as const;

export type PartType = (typeof PART_TYPES)[number];
export type ContentType = (typeof CONTENT_TYPES)[number];
export type PatternType = (typeof PATTERN_TYPES)[number];
export type ComponentType = PartType | ContentType | PatternType;
export type ComponentKind = "part" | "content" | "pattern";

/** The parts an outer part may hold in a slot (the inner parts). */
export const INNER_PART_TYPES = ["stack", "cards", "switcher"] as const satisfies readonly PartType[];

export type PropSpec =
  | { kind: "enum"; values: readonly string[]; default: string }
  | { kind: "int"; min: number; max: number; default: number }
  /** Free text for a class name: only `[A-Za-z0-9_ -]`, cut at `max`. */
  | { kind: "cls"; max: number }
  /** CSS text for one part: dropped whole over `max` (a cut could unbalance it). */
  | { kind: "css"; max: number }
  /** An opaque id of a note / tag / view. */
  | { kind: "ref" }
  /** A `^id` block id (without the caret). */
  | { kind: "blockId" };

export const REF_MAX = 100;
export const CLS_MAX = 60;
export const PART_CSS_MAX = 4000;
export const COMPONENTS_MAX = 200;
/** Levels counting content: top-level part → inner part → content. */
export const DEPTH_MAX = 3;

const COMMON_PART_PROPS: Record<string, PropSpec> = {
  bg: { kind: "enum", values: ["none", "tint"], default: "none" },
  heading: { kind: "enum", values: ["auto", "none"], default: "auto" },
  cls: { kind: "cls", max: CLS_MAX },
  css: { kind: "css", max: PART_CSS_MAX },
};

export type PartDef = { kind: "part"; label: string; slots: readonly string[]; props: Record<string, PropSpec>; topOnly: boolean };
export type ContentDef = { kind: "content"; label: string; slots: readonly []; props: Record<string, PropSpec> };

// The sidebar's slot is `aside`, not `side`: its `side` prop (left|right) takes that name in Puck's one props object.
export const PARTS: Record<PartType, PartDef> = {
  stack: { kind: "part", label: "堆疊", slots: ["items"], props: { ...COMMON_PART_PROPS }, topOnly: false },
  sidebar: {
    kind: "part", label: "側欄", slots: ["aside", "main"], topOnly: true,
    props: {
      side: { kind: "enum", values: ["left", "right"], default: "left" },
      width: { kind: "enum", values: ["s", "m"], default: "s" },
      ...COMMON_PART_PROPS,
    },
  },
  switcher: {
    kind: "part", label: "並排", slots: ["a", "b", "c", "d"], topOnly: false,
    props: { count: { kind: "int", min: 2, max: 4, default: 2 }, ...COMMON_PART_PROPS },
  },
  cards: {
    kind: "part", label: "卡片格", slots: ["items"], topOnly: false,
    props: { size: { kind: "enum", values: ["s", "l"], default: "s" }, ...COMMON_PART_PROPS },
  },
  cover: {
    kind: "part", label: "主視覺", slots: ["items"], topOnly: true,
    props: { height: { kind: "enum", values: ["m", "l"], default: "m" }, ...COMMON_PART_PROPS },
  },
  center: {
    kind: "part", label: "置中", slots: ["items"], topOnly: true,
    props: { width: { kind: "enum", values: ["s", "l"], default: "s" }, ...COMMON_PART_PROPS },
  },
};

export const CONTENT: Record<ContentType, ContentDef> = {
  note: {
    kind: "content", label: "筆記", slots: [],
    props: {
      noteId: { kind: "ref" },
      blockId: { kind: "blockId" },
      display: { kind: "enum", values: ["full", "first", "card", "title"], default: "full" },
    },
  },
  tag_view: {
    kind: "content", label: "標籤檢視", slots: [],
    props: {
      tagId: { kind: "ref" },
      viewId: { kind: "ref" },
      viewKind: { kind: "enum", values: ["list", "cards", "table"], default: "list" },
      limit: { kind: "int", min: 1, max: 12, default: 6 },
      sort: { kind: "enum", values: ["new", "title"], default: "new" },
    },
  },
  timeline: {
    kind: "content", label: "時間軸", slots: [],
    props: { tagId: { kind: "ref" }, limit: { kind: "int", min: 1, max: 12, default: 6 } },
  },
};

/** A content component a pattern pre-fills, and the props the user chooses. */
export type PatternContent = { type: ContentType; props: Record<string, unknown>; choose: readonly string[] };
export type PatternDef = {
  kind: "pattern";
  label: string;
  /** The part this pattern expands to ("展開成零件"); it has that part's props and slots. */
  expandsTo: PartType;
  /** The root part's props the pattern sets. */
  props: Record<string, unknown>;
  /** What each slot of the root part is pre-filled with. */
  slots: Record<string, readonly PatternContent[]>;
};

export const PATTERNS: Record<PatternType, PatternDef> = {
  pattern_intro_now: {
    kind: "pattern", label: "介紹＋近況", expandsTo: "sidebar",
    props: { side: "left", width: "s", heading: "auto" },
    slots: {
      aside: [{ type: "note", props: { display: "first" }, choose: ["noteId"] }],
      main: [{ type: "tag_view", props: { viewKind: "list", limit: 5, sort: "new" }, choose: ["tagId", "viewId"] }],
    },
  },
  pattern_work_cards: {
    kind: "pattern", label: "作品卡片", expandsTo: "stack",
    props: { heading: "auto" },
    slots: { items: [{ type: "tag_view", props: { viewKind: "cards", limit: 6, sort: "new" }, choose: ["tagId", "viewId"] }] },
  },
  pattern_three_entries: {
    kind: "pattern", label: "三欄入口", expandsTo: "switcher",
    props: { count: 3, heading: "none" },
    slots: {
      a: [{ type: "note", props: { display: "card" }, choose: ["noteId"] }],
      b: [{ type: "note", props: { display: "card" }, choose: ["noteId"] }],
      c: [{ type: "note", props: { display: "card" }, choose: ["noteId"] }],
    },
  },
  pattern_timeline: {
    kind: "pattern", label: "時間軸區塊", expandsTo: "stack",
    props: { heading: "auto" },
    slots: { items: [{ type: "timeline", props: { limit: 8 }, choose: ["tagId"] }] },
  },
};

export function kindOf(type: string): ComponentKind | null {
  if ((PART_TYPES as readonly string[]).includes(type)) return "part";
  if ((CONTENT_TYPES as readonly string[]).includes(type)) return "content";
  if ((PATTERN_TYPES as readonly string[]).includes(type)) return "pattern";
  return null;
}

/** The part a component behaves as: itself for a part, the root for a pattern. */
export function partTypeOf(type: string): PartType | null {
  if ((PART_TYPES as readonly string[]).includes(type)) return type as PartType;
  return type in PATTERNS ? PATTERNS[type as PatternType].expandsTo : null;
}

/** Slot names of any component ([] for content). */
export function slotsOf(type: string): readonly string[] {
  const part = partTypeOf(type);
  return part ? PARTS[part].slots : [];
}

/** Prop specs of any component (a pattern has its root part's). */
export function propSpecsOf(type: string): Record<string, PropSpec> {
  const part = partTypeOf(type);
  if (part) return PARTS[part].props;
  return type in CONTENT ? CONTENT[type as ContentType].props : {};
}

/** The slots of `type` that count: a switcher uses the first `count`. */
export function usedSlots(type: string, props: Record<string, unknown>): readonly string[] {
  const slots = slotsOf(type);
  if (partTypeOf(type) !== "switcher") return slots;
  const count = typeof props.count === "number" ? props.count : 2;
  return slots.slice(0, count);
}

// What a slot may hold, by where the part sits (the nesting rules, §5.1).
/** The top level: anything. Content sits there directly (drawn as if each had a
 *  default stack around it, topLevel.ts); parts and patterns arrange. */
export const TOP_ALLOW: readonly ComponentType[] = [...PART_TYPES, ...PATTERN_TYPES, ...CONTENT_TYPES];
/** A slot of a top-level part: content, or an inner part. */
export const OUTER_SLOT_ALLOW: readonly ComponentType[] = [...CONTENT_TYPES, ...INNER_PART_TYPES];
/** A slot of an inner part, or of a pattern: content only. */
export const INNER_SLOT_ALLOW: readonly ComponentType[] = [...CONTENT_TYPES];

/** Where a component sits, which decides what it may be: the top level, a slot
 *  of a top-level part ("outer"), or a slot of an inner part or a pattern. */
export type Place = "top" | "outer" | "inner";
const ALLOW_AT: Record<Place, readonly ComponentType[]> = { top: TOP_ALLOW, outer: OUTER_SLOT_ALLOW, inner: INNER_SLOT_ALLOW };

/** Whether a component of `type` may sit at `place` — the one nesting rule:
 *  validateDesign drops what fails it, the studio refuses to place it. */
export function allowedAt(place: Place, type: string): boolean {
  return (ALLOW_AT[place] as readonly string[]).includes(type);
}
