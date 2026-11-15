// The phone studio's moves on the home design, as plain data. The phone edits
// the same SiteDesignV2 the desktop studio saves, but only through these few
// moves; each returns a home that passes the same nesting rules (designModel is
// the shared source), and the screen saves through useHomeStudio.changeDesign,
// which runs validateDesignV2 before every save.
import {
  CONTENT_TYPES, PATTERNS, kindOf, propSpecsOf, slotsOf, patternDefaultSlots, walkHome,
  type PatternType, type PuckComponentData, type PuckData,
} from "@onden/site";
import { COMPONENT_LABELS } from "@onden/site/react";
import { findComponent, removeComponent, updateProps, withFreshIds } from "../studio/designModel";
import { t } from "../../../lib/i18n";
import { displayTitle } from "../../../lib/noteLabel";

// ── Reading the page as rows ─────────────────────────────────────────────

/** A content component a row can swap: the row's one note or tag view. */
export type Swappable = { id: string; kind: "note" | "tag_view" };

/** The one note / tag view a top-level block holds, when it holds exactly one
 *  content component (nested or not). A block with several, or with a time
 *  line, has no single slot to swap, so it is only moved or deleted. */
export function swappableOf(block: PuckComponentData): Swappable | null {
  const found: PuckComponentData[] = [];
  walkHome({ root: { props: {} }, content: [block] }, (component) => {
    if ((CONTENT_TYPES as readonly string[]).includes(component.type)) found.push(component);
  });
  const only = found.length === 1 ? found[0]! : null;
  return only && (only.type === "note" || only.type === "tag_view") ? { id: only.props.id, kind: only.type } : null;
}

export type RowNames = {
  /** null: the note is not on this device. */
  noteTitle: (noteId: string) => string | null;
  notePublished: (noteId: string) => boolean;
  tagName: (tagId: string) => string | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

function contentName(component: PuckComponentData, names: RowNames): string {
  const { props } = component;
  if (component.type === "note") {
    const id = text(props.noteId);
    if (!id) return t("No note chosen yet");
    const title = names.noteTitle(id);
    return names.notePublished(id) ? displayTitle(title) : t("{title} (not published)", { title: displayTitle(title) });
  }
  const tagId = text(props.tagId);
  const kind = component.type === "timeline" ? t("Timeline") : t("Tag view");
  if (!tagId) return t("{kind}: no tag chosen yet", { kind });
  return t("{kind}: {name}", { kind, name: displayTitle(names.tagName(tagId)) });
}

export type BlockRow = {
  id: string;
  /** What the block is, in plain words: the note's title, the tag view's name, or the block's own name. */
  title: string;
  /** For a block that holds several things, what is in it. */
  detail: string;
  swap: Swappable | null;
};

export function blockRows(home: PuckData, names: RowNames): BlockRow[] {
  return home.content.map((block) => {
    const contents: PuckComponentData[] = [];
    walkHome({ root: { props: {} }, content: [block] }, (c) => {
      if ((CONTENT_TYPES as readonly string[]).includes(c.type)) contents.push(c);
    });
    const swap = swappableOf(block);
    const label = COMPONENT_LABELS[block.type as keyof typeof COMPONENT_LABELS] ?? t("Block");
    if (swap) {
      return { id: block.props.id, title: contentName(contents[0]!, names), detail: kindOf(block.type) === "pattern" ? label : "", swap };
    }
    return { id: block.props.id, title: label, detail: contents.map((c) => contentName(c, names)).join("、"), swap: null };
  });
}

// ── Moves ────────────────────────────────────────────────────────────────

/** Move the top-level block up (-1) or down (+1); at an end it stays. */
export function moveBlock(home: PuckData, id: string, delta: -1 | 1): PuckData {
  const index = home.content.findIndex((c) => c.props.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= home.content.length) return home;
  const content = [...home.content];
  [content[index], content[target]] = [content[target]!, content[index]!];
  return { ...home, content };
}

export function deleteBlock(home: PuckData, id: string): PuckData {
  return home.content.some((c) => c.props.id === id) ? removeComponent(home, id) : home;
}

/** The note a block shows, replaced. A chosen paragraph belonged to the old
 *  note, so it is dropped: the new note shows whole (as chosen). */
export function swapNote(home: PuckData, contentId: string, noteId: string): PuckData {
  return findComponent(home, contentId)?.type === "note" ? updateProps(home, contentId, { noteId, blockId: "" }) : home;
}

export type TagViewChoice = { tagId: string; viewId: string; viewKind: "list" | "cards" | "table" };

/** The tag view a block shows, replaced by another tag and one of its views (viewId "" = the tag's default). */
export function swapTagView(home: PuckData, contentId: string, choice: TagViewChoice): PuckData {
  return findComponent(home, contentId)?.type === "tag_view"
    ? updateProps(home, contentId, { tagId: choice.tagId, viewId: choice.viewId, viewKind: choice.viewKind })
    : home;
}

// ── Block patterns ───────────────────────────────────────────────────────

/** What a pattern needs chosen before it is worth inserting: one entry per
 *  content slot, in page order. */
export type PatternSlot = { slot: string; index: number; kind: "note" | "tag_view" };

export function patternSlots(type: PatternType): PatternSlot[] {
  return Object.entries(PATTERNS[type].slots).flatMap(([slot, list]) =>
    list.flatMap((c, index) => (c.type === "note" || c.type === "tag_view" ? [{ slot, index, kind: c.type }] : [])));
}

export type SlotChoice = { kind: "note"; noteId: string } | { kind: "tag_view" } & TagViewChoice;

function patternBlock(type: PatternType): PuckComponentData {
  const props: PuckComponentData["props"] = { id: type };
  for (const [name, spec] of Object.entries(propSpecsOf(type))) props[name] = spec.kind === "enum" || spec.kind === "int" ? spec.default : "";
  for (const slot of slotsOf(type)) props[slot] = [];
  return { type, props: { ...props, ...PATTERNS[type].props, ...patternDefaultSlots(type) } };
}

function takenIds(home: PuckData): Set<string> {
  const ids = new Set<string>();
  walkHome(home, (c) => { ids.add(c.props.id); });
  return ids;
}

/** Insert the pattern at top-level `position` (0 = first; past the end = last)
 *  with its content slots filled by `choices` (same order as patternSlots). */
export function insertPattern(home: PuckData, type: PatternType, position: number, choices: readonly SlotChoice[]): PuckData {
  const block = withFreshIds(patternBlock(type), takenIds(home));
  const slots = patternSlots(type);
  slots.forEach(({ slot, index }, i) => {
    const choice = choices[i];
    const target = (block.props[slot] as PuckComponentData[] | undefined)?.[index];
    if (!choice || !target) return;
    target.props = choice.kind === "note"
      ? { ...target.props, noteId: choice.noteId, blockId: "" }
      : { ...target.props, tagId: choice.tagId, viewId: choice.viewId, viewKind: choice.viewKind };
  });
  const content = [...home.content];
  content.splice(Math.max(0, Math.min(position, content.length)), 0, block);
  return { ...home, content };
}
