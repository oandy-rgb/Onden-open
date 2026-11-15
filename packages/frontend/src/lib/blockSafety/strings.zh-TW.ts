// 段落被引用的提示、已刪除段落的救回、複製段落連結後貼上才綁定的繁中字串。
// 只有 blockSafety 的程式載入時才登記（index.ts），所以不佔開機 JS。

export const BLOCK_SAFETY_ZH_TW: Record<string, string> = {
  "Cited {n} times": "被引用 {n} 次",
  "Notes that cite this paragraph": "引用這段的筆記",
  "Cited here once": "引用 1 處",
  "Cited here {n} times": "引用 {n} 處",
  "This paragraph has 1 citation": "這段有 1 處引用",
  "This paragraph has {n} citations": "這段有 {n} 處引用",
  "Undo": "復原",
  "The note was edited since, so use the editor's undo": "筆記之後又改過，請改用編輯器的復原",
  "This paragraph was deleted": "這段已刪除",
  "This paragraph was deleted · Restore": "這段已刪除 · 救回",
  "Restore": "救回",
  "Restored the paragraph": "已救回這段",
  "Couldn't restore the paragraph": "無法救回這段",
  "The paragraph was already put back": "這段已經在筆記裡了",
  "{n} link points to this paragraph": "有 {n} 處連到這段",
  "{n} links point to this paragraph": "有 {n} 處連到這段",
};
