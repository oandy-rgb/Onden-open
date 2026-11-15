// 建議: what the studio notices about the home page. A suggestion is only
// computed; nothing is applied until the owner previews it and presses apply.
// Each one carries the design it would produce (so the canvas can show it
// before anything changes) and/or the notes to publish together.
import { bracesBalanced, INNER_PART_TYPES, kindOf, slotsOf, usedSlots, walkHome, type PuckComponentData, type SiteDesignV2 } from "@onden/site";
import { removeComponent, updateProps } from "./designModel";
import type { BlockedNote, StudioNote } from "./editorData";
import { t } from "../../../lib/i18n";
import { displayTitle } from "../../../lib/noteLabel";

export type SuggestionKind = "unpublished" | "private_space" | "many_cards" | "empty_slot" | "empty_choice" | "bad_css" | "too_long";

export type Suggestion = {
  /** Stable across recomputes, so a preview survives edits elsewhere. */
  id: string;
  kind: SuggestionKind;
  /** One plain sentence. */
  text: string;
  /** The design the suggestion would produce (preview and apply). */
  design?: SiteDesignV2;
  /** 「一起發布」: mark these notes published (the server's include). */
  includeNoteIds?: string[];
  /** Select this component (to choose another note, or fill it). */
  selectComponentId?: string;
  /** The site's settings (the right column with nothing selected) are where this is fixed. */
  styleTab?: boolean;
  applyLabel?: string;
};

export const CARDS_MAX = 4;
export const TOP_BLOCKS_MAX = 5;

/** `css` with the missing closing braces added, or null when it cannot be
 *  repaired by appending (a `}` with no `{`, or a string/comment left open). */
export function repairBraces(css: string): string | null {
  if (bracesBalanced(css)) return css;
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") i++;
    else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < css.length && css[i] !== c) { if (css[i] === "\\") i++; i++; }
      if (i >= css.length) return null;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return null;
  }
  return depth > 0 ? `${css.trimEnd()}\n${"}".repeat(depth)}` : null;
}

const withHome = (design: SiteDesignV2, home: SiteDesignV2["home"]): SiteDesignV2 => ({ ...design, home });
const isEmptyChoice = (c: PuckComponentData) =>
  (c.type === "note" && !c.props.noteId) || ((c.type === "tag_view" || c.type === "timeline") && !c.props.tagId);

export type SuggestInput = {
  design: SiteDesignV2;
  /** The notes the studio lists (on a space that can publish). */
  notes: readonly StudioNote[];
  /** Notes something keeps off the site: a block that points at one is told so. */
  blocked: readonly BlockedNote[];
  /** Rows the canvas shows per tag_view / timeline id (from the editor metadata). */
  rowCounts: Readonly<Record<string, number>>;
};

export function computeSuggestions({ design, notes, blocked, rowCounts }: SuggestInput): Suggestion[] {
  const out: Suggestion[] = [];
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const blockedById = new Map(blocked.map((n) => [n.id, n]));
  const seenNotes = new Set<string>();

  walkHome(design.home, (component) => {
    const id = component.props.id;
    if (component.type === "note" && typeof component.props.noteId === "string" && component.props.noteId) {
      const noteId = component.props.noteId;
      const stuck = blockedById.get(noteId);
      const note = noteById.get(noteId);
      if (stuck && !seenNotes.has(noteId)) {
        seenNotes.add(noteId);
        const name = displayTitle(stuck.title);
        out.push({
          id: `private:${noteId}`, kind: "private_space", selectComponentId: id, applyLabel: t("Pick another note"),
          text: stuck.blocker.reason === "space"
            ? t("“{title}” is in “{space}”, which is not published, so this spot on the site will be empty.", { title: name, space: stuck.blocker.space })
            : t("“{title}” is hidden and will not be published, so this spot on the site will be empty.", { title: name }),
        });
      } else if (note && !note.published && !seenNotes.has(note.id)) {
        seenNotes.add(note.id);
        out.push({
          id: `unpublished:${note.id}`, kind: "unpublished", includeNoteIds: [note.id], selectComponentId: id, applyLabel: t("Publish it too"),
          text: t("“{title}” is not published yet, so this spot on the site will be empty.", { title: displayTitle(note.title) }),
        });
      }
    }
    if (component.type === "tag_view" && component.props.viewKind === "cards") {
      const limit = typeof component.props.limit === "number" ? component.props.limit : 6;
      const shown = Math.min(limit, rowCounts[id] ?? 0);
      if (shown > CARDS_MAX) {
        out.push({
          id: `cards:${id}`, kind: "many_cards", applyLabel: t("Show at most 4"),
          text: t("The cards show {n} notes at once, which makes a very long page on a phone.", { n: shown }),
          design: withHome(design, updateProps(design.home, id, { limit: CARDS_MAX })),
        });
      }
    }
    if (isEmptyChoice(component)) {
      out.push({
        id: `choice:${id}`, kind: "empty_choice", selectComponentId: id, applyLabel: t("Choose one"),
        text: component.type === "note" ? t("A spot has no note chosen yet.") : t("A spot has no tag chosen yet."),
      });
    }
    if (kindOf(component.type) !== "content") {
      const used = usedSlots(component.type, component.props);
      const empty = used.filter((slot) => {
        const children = component.props[slot];
        return !Array.isArray(children) || children.length === 0;
      });
      if (empty.length > 0 && slotsOf(component.type).length > 0) {
        const allEmpty = empty.length === used.length;
        out.push({
          id: `empty:${id}`, kind: "empty_slot", applyLabel: allEmpty ? t("Remove the empty part") : t("Select it"),
          text: allEmpty ? t("A part is empty, so the site will show only blank space.") : t("One side of a part is still empty."),
          ...(allEmpty ? { design: withHome(design, removeComponent(design.home, id)) } : { selectComponentId: id }),
        });
      }
    }
    const css = component.props.css;
    if (typeof css === "string" && css.trim() !== "" && !bracesBalanced(css)) {
      const repaired = repairBraces(css);
      out.push({
        id: `css:${id}`, kind: "bad_css", applyLabel: repaired ? t("Add the missing brace") : t("Select it"),
        text: t("A part’s CSS has unmatched braces, so it was not applied."),
        ...(repaired ? { design: withHome(design, updateProps(design.home, id, { css: repaired })) } : { selectComponentId: id }),
      });
    }
  });

  if (design.css.trim() !== "" && !bracesBalanced(design.css)) {
    const repaired = repairBraces(design.css);
    out.push({
      id: "css:site", kind: "bad_css", applyLabel: repaired ? t("Add the missing brace") : t("Edit in site settings"),
      text: t("The site-wide CSS has unmatched braces, so it was not applied."),
      ...(repaired ? { design: { ...design, css: repaired } } : { styleTab: true }),
    });
  }

  const top = design.home.content;
  if (top.length > TOP_BLOCKS_MAX) {
    const tail = top.slice(TOP_BLOCKS_MAX);
    // Folding the tail into one stack is only offered when every block fits
    // inside a part: content, or an inner part that holds content only.
    const foldable = tail.every((block) =>
      kindOf(block.type) === "content"
      || ((INNER_PART_TYPES as readonly string[]).includes(block.type)
      && slotsOf(block.type).every((slot) => (block.props[slot] as PuckComponentData[] | undefined ?? []).every((child) => kindOf(child.type) === "content"))));
    out.push({
      id: "long", kind: "too_long", applyLabel: foldable ? t("Fold the rest into one group") : undefined,
      text: t("The home page has {n} blocks, which takes a long scroll; past {max} blocks, consider folding some.", { n: top.length, max: TOP_BLOCKS_MAX }),
      ...(foldable ? { design: foldTail(design, tail) } : {}),
    });
  }
  return out;
}

function foldTail(design: SiteDesignV2, tail: PuckComponentData[]): SiteDesignV2 {
  const head = design.home.content.slice(0, TOP_BLOCKS_MAX);
  const holder: PuckComponentData = {
    type: "stack",
    props: { id: "stack-folded", bg: "none", heading: "none", cls: "", css: "", items: tail },
  };
  const taken = new Set<string>();
  walkHome(design.home, (c) => { taken.add(c.props.id); });
  if (taken.has("stack-folded")) holder.props.id = `stack-folded-${taken.size}`;
  return withHome(design, { ...design.home, content: [...head, holder] });
}
