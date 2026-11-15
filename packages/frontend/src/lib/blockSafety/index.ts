// 段落引用的安全網，一個入口（import "lib/blockSafety"）：
//   - citations / editorCitations: 「被引用 N 次」的數字、列表與刪除提示
//   - recovery: 「這段已刪除 · 救回」
//   - pendingLink: 複製的段落連結貼上時綁定到那一段
// 繁中字串在這裡登記，所以這些程式沒載入時不佔開機 JS。
import { registerDictionary } from "../i18n";
import { BLOCK_SAFETY_ZH_TW } from "./strings.zh-TW";

registerDictionary("zh-TW", BLOCK_SAFETY_ZH_TW);

export { citationCount, groupCitations, NO_CITATIONS, type BlockCitationRow, type BlockCitations } from "./citations";
export { citationOpener, editorCitations, editorLinkedParagraphs, removedCitedCounts, setCitations, type LinkedParagraph } from "./editorCitations";
export { deletedBlockFrom, findDeletedBlock, offerDeletedBlock, restoreDeletedBlock, withBlockRestored, type DeletedBlock } from "./recovery";
export { pasteBlockLink, type PasteContext } from "./pendingLink";
