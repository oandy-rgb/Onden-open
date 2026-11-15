// The page-surface pieces every page shares (PDF page, handwriting page, later a
// slide): the text-box layer and its toolbar tool.
export { default as TextBoxLayer, type TextBoxMode } from "./TextBoxLayer";
export { TEXT_TOOL } from "./textTool";
export { default as PageImageLayer, type PageImageMode } from "./PageImageLayer";
export { default as InkRegionLayer, type CopyNotice } from "./InkRegionLayer";
export { QUOTE_TOOL } from "./quoteTool";
