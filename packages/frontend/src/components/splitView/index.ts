// Side by side: the right pane, the divider between the sides, the landing shown
// while something is dragged to the right (a phone has none: lib/splitViewStore `canSplit`)
// (docs/agents/decisions-ui.md, 視角＋並排). State is lib/splitViewStore.
import { lazyWithReload } from "../../lib/lazyWithReload";

/** The right pane loads when a second side opens (it brings the page outlet with it). */
export const SplitPane = lazyWithReload(() => import("./SplitPane"));
/** The divider and the 「放進另一邊」 button exist only while a second side is open, so they load with it. */
export const SplitDivider = lazyWithReload(() => import("./SplitDivider"));
export const QuoteToOther = lazyWithReload(() => import("./QuoteToOther"));
export { default as SplitDropHint } from "./SplitDropHint";
