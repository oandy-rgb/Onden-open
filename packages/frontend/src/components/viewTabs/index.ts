// The row of view tabs above a note or a tag, the pane of a saved-view tab,
// and what both need to know about the page (docs/agents/decisions-ui.md).
export { default as ViewTabs } from "./ViewTabs";
export { default as OwnerViewPane } from "./OwnerViewPane";
export { useViewOwner, type ViewOwnerInfo } from "./useViewOwner";
export type { AddViewSource } from "./useAddView";
export { ViewStripBar, ViewStripEnd, ViewStripProvider, useViewStripHost, useInViewStrip } from "./ViewStrip";
export { useOwnerTabs } from "./useAddView";
