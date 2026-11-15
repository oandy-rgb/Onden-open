// 寫進 baseline.json 的原因：依規則與元素選擇器給一句白話（指到元件／樣式的位置在 docs/research/layout-audit-2026-11-02.md）。
// 沒有對應的寫「待分析」，由人補上。baselineReason 只看規則與元素，所以 `--rewrite-reasons` 不必重跑審核。
const REASONS = [
  ["R1", /tag-member-list--flat > button/, "關係區「子筆記」列表每列 min-height 40px，但 ::after 的點擊範圍撐到 44px，相鄰兩列的點擊範圍互相蓋住 2px。"],
  ["R1", /prop-tag-name/, "手機上「加上標籤」按鈕擴大後的點擊範圍，蓋住左邊相鄰標籤名稱的右側角落。"],
  ["R1", /obsidian-group-title/, "手機側欄：展開箭頭按鈕擴大後的點擊範圍，蓋住旁邊標題按鈕的左側角落。"],
  ["R1", /sb-bar-btn|sidebar-search-toggle/, "手機側欄標題列相鄰的圖示按鈕（搜尋、建立、更多）擴大後的點擊範圍，互相蓋到角落。"],
  ["R1", /links-relation-list/, "資訊欄「連結」列表相鄰兩列的點擊範圍互相蓋到角落（手機）。"],
  ["R1", /board-selection-bar/, "白板「選取的卡片」工具列相鄰按鈕的點擊範圍互相蓋到角落（手機）。"],
  ["R3", /settings-list/, "手機設定的清單卡片為了圓角用 overflow:hidden，內容比框高 3px，底部 3px 被裁掉。"],
  ["R5", /card-node-title-input/, "白板卡片標題輸入框：滑鼠移到卡片上時寬度由 227px 縮成 205px（hover 才出現的元素佔掉位置）。"],
  ["R7", /user-chip/, "手機標題列的帳號按鈕只有 43×44 的可點區域（差 1px）。"],
  ["R7", /info-panel-tab/, "手機資訊欄分頁按鈕可點高度 41px，不足 44px。"],
  ["R7", /obsidian-page-button|obsidian-group-toggle/, "手機側欄筆記樹的列高 40px（可點高度約 40–43px），不足 44px。"],
  ["R7", /tag-member-list|note-relations-toggle|links-relation-list/, "關係區／資訊欄的列表列可點高度不足 44px（手機）。"],
  ["R7", /sb-bar-btn|sidebar-search-toggle|schema-lens-icon-btn|quick-capture-kind|quick-capture-more|quick-capture-place/, "圖示按鈕或小按鈕的可點寬度約 33–41px，不足 44px（手機）。"],
  ["R7", /card-|wikilink-token|react-flow|ui-btn--icon|ui-btn--ghost|note-actions-more-btn/, "白板上的按鈕在手機縮放後小於 44×44（卡片內的按鈕隨縮放變小；工具列與縮放鈕約 40px）。"],
  ["R7", /./, "手機上這個可點元素的可點區域小於 44×44（量到的數字見報告）。"],
];

export function baselineReason(v) {
  const hit = REASONS.find(([rule, pattern]) => rule === v.rule && pattern.test(v.element));
  return hit ? hit[2] : "待分析";
}
