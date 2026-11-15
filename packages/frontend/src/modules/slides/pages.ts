// Moved to @onden/markdown (slidePages.ts) so the server's getSlides cuts pages the same way; this file keeps the old
// import path working. `Page` is the package's `SlidePage`.
export {
  pagesOf, partsOf, autoLayoutOf, layoutOfPage, chosenLayout, layoutSource, layoutsByPageKey, isLayoutId, LAYOUT_IDS, MAX_SUBTITLE, NUMBER_LEAD, TIME_LEAD,
  type SlidePage as Page, type SlidePageParts as PageParts, type LayoutId,
} from "@onden/markdown";
