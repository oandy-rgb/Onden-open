import type { Extension } from "@codemirror/state";
import { editorCallouts } from "./editorCallouts";
import { editorCheckboxes } from "./editorCheckboxes";
import type { EmbedContext } from "./editorEmbeds";
import { editorMath } from "./editorMath";
import { editorTables } from "./editorTables";

/** Everything the note editor draws as the finished thing over the Markdown
 *  text, which is never changed: formulas, embeds and pictures, tables,
 *  callout lines, checkboxes. One list, so one switch (a 「原文」 setting) can
 *  take the whole group out. Three ways to be drawn (decisions-ui.md):
 *  always the finished thing (checkboxes), the text on a deliberate press
 *  (tables, embeds, formulas), styled text that never swaps (callouts). */
export function editorRendered(embeds: Extension, tableContext: () => EmbedContext): Extension[] {
  return [editorMath, embeds, editorTables(tableContext), editorCallouts, editorCheckboxes];
}
