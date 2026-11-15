// Side by side: the right pane, the divider between the sides, the landing shown
// while something is dragged to the right (a phone has none: lib/splitViewStore `canSplit`)
// (docs/agents/decisions-ui.md, 視角＋並排). State is lib/splitViewStore.
import { lazyWithReload } from "../../lib/lazyWithReload";

/** The right pane loads when a second side opens (it brings the page outlet with it). */
export const SplitPane = lazyWithReload(() => import("./SplitPane"));
export { default as SplitDivider } from "./SplitDivider";
export { default as SplitDropHint } from "./SplitDropHint";
export { default as QuoteToOther } from "./QuoteToOther";
