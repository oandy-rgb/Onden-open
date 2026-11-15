// 日記時間軸上「外部行事曆行程」的繁中字串。只有日子面板載入時才登記（strings.ts），所以不佔開機 JS。

export const DAY_EXTERNAL_ZH_TW: Record<string, string> = {
  "All day": "整天",
  "All-day events": "整天的行程",
  "Place: ": "地點：",
  "From {calendar}": "來自「{calendar}」",
  "Take notes": "記筆記",
  "Open the note": "打開筆記",
};

// 拖動、拉長區塊的字串（時間軸的 useBlockDrag）。
export const DAY_BLOCK_DRAG_ZH_TW: Record<string, string> = {
  "Moved to {time}": "已移到 {time}",
  "Moved to {date}": "已移到 {date}",
  "Length is now {time}": "時間改為 {time}",
  "Alt + ↑ ↓ moves it by 15 minutes; Alt + Shift + ↑ ↓ changes its length": "Alt＋上下鍵移動 15 分鐘；Alt＋Shift＋上下鍵改變長度",
};
