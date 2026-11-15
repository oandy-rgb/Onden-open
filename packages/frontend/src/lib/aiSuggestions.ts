// AI suggestions in a note, as the person sees them (docs/agents/decisions-ai-collaboration.md).
// Pure: where each pending place sits in the text as it is now, what the bar
// above the note says, and the words. The server (routes/aiSuggestions.ts)
// decides what may be accepted and merges it; this file only draws. Paragraphs
// are @onden/markdown's, the same cut the server uses to name a place, so a
// place found here is the place the server means. Nothing here shows an id,
// a code or the server's own message (AGENTS.md, 使用者介面文字).

import { findParagraph, splitParagraphs } from "@onden/markdown";
import { t, tn } from "./i18n";
import type { NoteSuggestion, SuggestionItem, SuggestionItemKind, SuggestionSkill } from "@onden/contract";

export type SuggestionsView = { suggestions: NoteSuggestion[]; can_decide: boolean };

export type Decision = "accept" | "reject";

/** A place drawn in the text. `from`–`to` is the paragraph it is about (struck
 *  through for a replace or delete); the widget sits at `at`, after it. */
export type Place = {
  /** The item's id: what a button decides. */
  itemId: string;
  suggestionId: string;
  kind: "replace" | "insert" | "delete" | "comment";
  from: number;
  to: number;
  at: number;
  /** What the AI wants there (a comment's text, the new paragraph); null for a delete. */
  newText: string | null;
  /** The words stay as they are; only the blank space around the paragraph changes (tight ↔ loose list). */
  spacingOnly: boolean;
  /** The words stay as they are; only indentation, a line's end or a hard line break changes. */
  indentOnly?: true;
  agentName: string;
  older: boolean;
  /** The decision is being sent: the buttons wait. */
  busy: boolean;
  /** The buttons may be pressed (can edit the note, and the connection is up). */
  canAct: boolean;
};

/** A suggestion the text cannot show in place: the title, a comment on no
 *  paragraph, a place whose paragraph the person has since edited or the
 *  server found changed. Listed in the bar instead. */
export type OffPlace = {
  itemId: string;
  suggestionId: string;
  kind: SuggestionItemKind;
  text: string;
  agentName: string;
  older: boolean;
  /** "changed": the place was edited, so the AI's version cannot be applied (dismiss only). */
  state: "open" | "changed";
};

export type SuggestionLayout = {
  places: Place[];
  off: OffPlace[];
  /** Every pending-or-changed item, for the bar's count. */
  total: number;
  /** Items the server would accept (not "changed"), for "accept all". */
  actionable: number;
  /** The skills behind the suggestions still listed, once each (the bar's header). */
  skills: SuggestionSkill[];
};

type Conditions = { markdown: string; canEdit: boolean; online: boolean; busy: ReadonlySet<string> };

/** Where each item of `view` sits in `markdown` now: the paragraph the server names (`item.place`), found by its
 *  text. A place the server cannot find (the paragraph was edited or is gone) moves to `off` as "changed". */
export function layoutSuggestions(view: SuggestionsView | null, { markdown, canEdit, online, busy }: Conditions): SuggestionLayout {
  const layout: SuggestionLayout = { places: [], off: [], total: 0, actionable: 0, skills: [] };
  if (!view) return layout;
  const paragraphs = splitParagraphs(markdown);
  const canAct = view.can_decide && canEdit && online;
  for (const suggestion of view.suggestions) {
    if (suggestion.skill && suggestion.items.length > 0
      && !layout.skills.some((skill) => skill.name === suggestion.skill!.name && skill.picked === suggestion.skill!.picked)) layout.skills.push(suggestion.skill);
    for (const item of suggestion.items) {
      const common = { itemId: item.id, suggestionId: suggestion.id, agentName: suggestion.agent_name, older: suggestion.older };
      const spacingOnly = item.change === "spacing";
      const indentOnly = item.change === "indent";
      layout.total++;
      if (item.status === "stale") {
        layout.off.push({ ...common, kind: item.kind, text: item.new_text ?? "", state: "changed" });
        continue;
      }
      if (item.kind === "title") {
        layout.off.push({ ...common, kind: "title", text: item.new_text ?? "", state: "open" });
        layout.actionable++;
        continue;
      }
      // The server says which paragraph of the note this is now (an accepted place may have rewritten its anchor).
      const anchored = item.place !== undefined ? item.place : { text: item.base_text, occurrence: item.base_occurrence };
      const index = item.base_text === "" && (item.kind === "insert" || item.kind === "comment") ? -1
        : anchored === null ? -1 : findParagraph(paragraphs, anchored.text, anchored.occurrence);
      if (index === -1 && item.base_text !== "") {
        // The paragraph is gone from the text: a comment still reads, a change cannot be applied.
        layout.off.push({ ...common, kind: item.kind, text: item.new_text ?? "", state: item.kind === "comment" ? "open" : "changed" });
        if (item.kind === "comment") layout.actionable++;
        continue;
      }
      if (index === -1) {
        // Anchored on nothing: an insert at the very start, or a comment about the whole note.
        if (item.kind === "comment") { layout.off.push({ ...common, kind: "comment", text: item.new_text ?? "", state: "open" }); layout.actionable++; continue; }
        layout.places.push({ ...common, kind: "insert", from: 0, to: 0, at: 0, newText: item.new_text, spacingOnly: false, busy: busy.has(item.id), canAct });
        layout.actionable++;
        continue;
      }
      const p = paragraphs[index]!;
      layout.places.push({
        ...common, kind: item.kind as Place["kind"], newText: item.new_text, spacingOnly, ...(indentOnly ? { indentOnly: true as const } : {}),
        from: item.kind === "insert" || item.kind === "comment" ? p.end : p.start, to: p.end, at: p.end,
        busy: busy.has(item.id), canAct,
      });
      layout.actionable++;
    }
  }
  return layout;
}

/** The order the bar steps through places: top of the note first. */
export const placesInOrder = (places: readonly Place[]): Place[] => [...places].sort((a, b) => a.at - b.at);

// ── words ───────────────────────────────────────────────────────────────────

export const labelFor = {
  badge: (name: string) => t("{name} suggests", { name: name || t("The AI") }),
  commentBadge: (name: string) => t("{name} left a comment", { name: name || t("The AI") }),
  accept: () => t("Accept"),
  reject: () => t("Reject"),
  markRead: () => t("Mark as read"),
  dismiss: () => t("Ignore"),
  deleteHint: () => t("Suggests removing this paragraph"),
  spacingHint: () => t("Only the spacing around this paragraph changes"),
  indentHint: () => t("Only the indentation or line ends of this paragraph change"),
  older: () => t("Older than 30 days"),
  offline: () => t("Accepting or rejecting needs a connection."),
  changed: () => t("You've edited this part, so this suggestion can't be applied."),
  skillUsed: (name: string) => t("AI suggestion · used “{name}”", { name }),
  skillPicked: (name: string) => t("AI suggestion · picked “{name}” itself", { name }),
  titleLine: (title: string) => t("Suggests the title: {title}", { title }),
};

export function barSummary(layout: SuggestionLayout): string {
  return tn("1 AI suggestion in this note", "{count} AI suggestions in this note", layout.total);
}

/** What to tell the person after a decision, or null when nothing needs saying. */
export function decisionNotice(result: { accepted?: string[]; stale?: string[]; void?: string[]; alreadyDecided?: string[] }): string | null {
  const stale = (result.stale ?? []).length;
  if (stale > 0) return tn("1 place had changed since the AI wrote it, so it wasn't applied.", "{count} places had changed since the AI wrote them, so they weren't applied.", stale);
  if ((result.void ?? []).length > 0) return t("These suggestions are for a note that has moved, so they no longer apply.");
  return null;
}

/** The places still waiting for a decision, in the order the AI filed them. */
export function pendingItems(view: SuggestionsView | null): SuggestionItem[] {
  return (view?.suggestions ?? []).flatMap((s) => s.items.filter((i) => i.status === "pending"));
}
