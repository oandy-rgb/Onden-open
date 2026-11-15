// The tag page (a class_tag opened as a node): its notes, functions, merge /
// delete confirmations and the owner's field and function rows. Import from
// "components/tagPage". The default export is the page; the files inside
// split it by job (see TagPage.tsx's header).
export { default } from "./TagPage";
export type { TagPageProps } from "./TagPage";
export { promotableProperties } from "./promotable";
// The field settings popover for a tag's table view (a column name opens it).
export { default as TagFieldsHost } from "./TagFieldsHost";
