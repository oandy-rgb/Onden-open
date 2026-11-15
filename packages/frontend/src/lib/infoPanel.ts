// The notes page's info panel (tabs 「功能」「標籤」「關係」「AI」): which tab opens.

export type InfoTab = "functions" | "tags" | "relations" | "ai";
export const INFO_TABS: readonly InfoTab[] = ["functions", "tags", "relations", "ai"];

/** A saved tab preference as a tab. The retired 「段落」 (`headings`, now the
 *  edge outline beside the text) and anything unknown count as "never picked". */
/** The tabs shown: AI's only while AI is on (modules/ai). */
export function infoTabsFor(aiOn: boolean): readonly InfoTab[] {
  return aiOn ? INFO_TABS : INFO_TABS.filter((tab) => tab !== "ai");
}

export function pickedInfoTab(raw: unknown): InfoTab | null {
  return INFO_TABS.find((tab) => tab === raw) ?? null;
}

/** The tab to show: the person's own last pick, else 「功能」 (the note's ties to
 *  Onden's other features, the first tab); only when it has nothing at all, the
 *  tags when the note has any, else the relations when it has any, else the AI
 *  tab: a note with nothing else to show would leave the panel empty, and
 *  「AI」 is where a question about it goes. */
export function initialInfoTab(picked: InfoTab | null, note: { hasFunctions: boolean; hasTags: boolean; hasRelations: boolean }, aiOn = true): InfoTab {
  if (picked && (aiOn || picked !== "ai")) return picked;
  if (note.hasFunctions) return "functions";
  if (note.hasTags) return "tags";
  return note.hasRelations || !aiOn ? "relations" : "ai";
}
