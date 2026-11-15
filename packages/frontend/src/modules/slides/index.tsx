// Slides module (frontend) — any note as slides (docs/architecture/presentation.md):
// noteView — 「簡報」, a tab of the note's view row that draws the note's own
// text as slides (docs/architecture/proposals/slides-2026-10-31.md); the screen,
// layouts and styles load when the tab opens. noteCommands — 「簡報」 plays the
// note full screen (split on `---`, else `##`). Onden makes no outline itself: the `outline` skill is an MCP prompt
// for your own AI, and its result is an ordinary note.
import { lazyWithReload } from "../../lib/lazyWithReload";
import { Presentation } from "lucide-react";
import type { FrontendModule } from "../types";
import { isNote } from "@onden/markdown/contract";

const SlidesPane = lazyWithReload(() => import("./SlidesPane"));

export const slidesModule: FrontendModule = {
  id: "slides",
  library: {
    title: "Slides",
    description: "Play any note as slides, or have your AI outline a board or a tag's notes through MCP.",
    Icon: Presentation,
    // A way of seeing a note, chosen with 「＋」 like the other views, never switched (owner, 2026-11-15).
    alwaysOn: true,
    manifest: {
      adds: [
        { kind: "command", text: "「Slides」 in the note menu plays a note full screen." },
        { kind: "command", text: "「Export as slides (PPTX)」 saves a note's slides as a PowerPoint file." },
        { kind: "view", text: "A Slides tab on a note shows its text as slides." },
      ],
      notes: "Reads the notes you play.",
      network: null,
    },
  },
  noteView: { Pane: SlidesPane },
  noteFunctionRows: () => import("./noteFunctionRows"),
  noteCommands: [
    {
      id: "a-present",
      label: "Present as slides",
      keywords: ["slides", "present", "presentation", "deck", "簡報", "投影片"],
      available: (node, body) => isNote(node) && !!body.trim(),
      // Its 功能-tab row (a deck's page count, or an offer to play any note) is in noteFunctionRows.
      run: async ({ node, openNode }) => (await import("./present")).presentNote(node, openNode),
    },
    {
      id: "a-export-pptx",
      label: "Export as slides (PPTX)",
      keywords: ["slides", "pptx", "powerpoint", "export", "簡報", "投影片", "匯出"],
      available: (node, body) => isNote(node) && !!body.trim(),
      run: async ({ node, openNode }) => (await import("./exportPptx/open")).openPptxExport(node, openNode),
    },
  ],
};
