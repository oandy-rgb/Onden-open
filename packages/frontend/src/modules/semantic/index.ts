// Semantic search module (frontend) — the module library's card for semantic
// search (語意搜尋). Its backend embeds notes with a local model and files
// related-note suggestions as `suggested` edges, which a board draws animated
// for the person to keep or dismiss. One of three built-in functions that wait
// for the owner's one-time yes (user, 2026-10-18: 「語意搜尋要關」, then
// 2026-10-24: built-in functions are on by default, except where it costs
// money): the model is heavy, so it is off until the yes, and the shell asks
// the registry whether link suggestions are on (`suggestsLinks`,
// useLinkSuggestionsShown) and hides them when not.
import { Search } from "lucide-react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import type { FrontendModule } from "../types";

const SemanticIndexWidget = lazyWithReload(() => import("./SemanticIndexWidget"));

export const semanticModule: FrontendModule = {
  id: "semantic",
  suggestsLinks: true,
  // The one note search adds notes near the query's meaning after its exact matches (lib/data/noteSearch).
  shellFeature: "meaning-search",
  settings: [{
    id: "modules.semantic_index",
    tab: "modules",
    label: "Notes ready for search by meaning",
    keywords: ["semantic", "meaning", "index", "ready", "語意", "意思", "筆記", "準備"],
    type: "custom",
    component: SemanticIndexWidget,
  }],
  library: {
    title: "Semantic search",
    confirm: "Semantic search uses an AI model on the server to read all your notes and find related ones. It is heavy to run and costs computing fees, so it only starts after you say yes.",
    description: "Find notes by meaning when you search, not just matching words, and suggest links between related notes on a board. Needs the local embedding model on the server, which is heavy to run. Asks once before it starts.",
    Icon: Search,
    group: { id: "search", order: 1 },
    blurb: "Find notes by meaning, not just words",
    manifest: {
      adds: [
        { kind: "schedule", text: "Prepares the notes you already have when you turn it on, then each note again when it changes." },
        { kind: "command", text: "Notes found by meaning after the exact matches in search, related-note suggestions on boards, and search by meaning for agents." },
      ],
      notes: "Reads every note in the workspace to index it.",
      network: "Runs a model on the server, downloaded on first use; your notes are not sent to another service.",
    },
  },
};
