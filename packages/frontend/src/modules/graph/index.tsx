// Graph — a built-in module (docs/agents/decisions-modules.md): the whole-
// workspace force graph and the 「完整關係」 view of one note have a module's
// boundary and registry entry, but they are always available, so there is no
// `library` card, no switch and no "off" state, and Settings › Modules does not
// list it. It is purely frontend: the graph is drawn from the notes and edges
// the app already holds, so it has no backend twin.
//
// The graph code (and react-force-graph) stays out of the main bundle: the
// screen is lazy, loaded when the Graph place opens.

import { lazyWithReload } from "../../lib/lazyWithReload";
import type { BuiltInModule } from "../types";

export const graphModule: BuiltInModule = {
  id: "graph",
  frontendOnly: true,
};

/** The Graph place's screen (`?view=graph`, with `&focus=<noteId>` for 「完整關係」). */
export const GraphScreen = lazyWithReload(() => import("./LocalGraphLens"));
