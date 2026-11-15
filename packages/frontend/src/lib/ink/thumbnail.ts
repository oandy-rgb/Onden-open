// Static SVG thumbnail of an ink document — the read-only picture a review
// card shows without booting the full InkEngine. The renderer is shared with
// `![[drawing]]` embeds and the published site (@onden/markdown inkSvg.ts):
// same outline geometry as the live renderer, erased intervals honoured, and
// stroke colours sanitised before the string is injected as markup.
export { inkToSvg as inkThumbnailSvg } from "@onden/markdown/ink";
