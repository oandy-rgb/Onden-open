import type { ModuleDefinition } from "../types.js";
import type { AgentTool } from "../../services/agentTools/index.js";
import { getSlides, setSlideLayout } from "./deckTools.js";

// Slides (docs/architecture/presentation.md): play any note as slides. The
// built-in `outline` skill (an MCP prompt) lets the owner's AI write one
// from a board or a tag. Playing runs in the browser over existing paths — the
// outline is an ordinary note — so the module owns no
// tables or routes, and no tags; importing it only shows its commands and the note's
// 「簡報」 view (layout "slides": a tab on the note, drawn from its text; the
// view's choices are the note attribute slides_data).
export const slidesModule: ModuleDefinition = {
  id: "slides",
  registerRoutes: () => {},
  noteViewLayout: true,
  // The agent reads a note's pages and sets their layouts (deckTools.ts); only where the module is imported.
  agentTools: [getSlides as AgentTool, setSlideLayout as AgentTool],
  // Always on (owner, 2026-11-15): a workspace whose stored list lacks it has it again, nothing stored changes.
  library: { alwaysOn: true },
};
