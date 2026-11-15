// Chinese labels of the fields and their options in the studio panel.
export const FIELD_LABELS: Record<string, string> = {
  bg: "背景", heading: "標題", cls: "class 名稱", css: "這個零件的 CSS", side: "側欄位置", width: "寬度", count: "並排塊數",
  size: "卡片大小", height: "高度", noteId: "筆記", blockId: "段落 ^id（空白＝整篇）", display: "顯示方式", tagId: "標籤",
  viewId: "檢視", viewKind: "呈現", limit: "最多幾篇", sort: "排序",
  items: "內容", aside: "側欄", main: "主要", a: "第 1 塊", b: "第 2 塊", c: "第 3 塊", d: "第 4 塊",
};

/** Option labels by prop name; `width` differs by component, see WIDTH_LABELS. */
export const OPTION_LABELS: Record<string, Record<string, string>> = {
  bg: { none: "無", tint: "淡色底" },
  heading: { auto: "自動（標籤名稱）", none: "不顯示" },
  side: { left: "左", right: "右" },
  size: { s: "小", l: "大" },
  height: { m: "中", l: "高" },
  display: { full: "整篇", first: "摘要", card: "卡片", title: "只有標題" },
  viewKind: { list: "清單", cards: "卡片", table: "表格" },
  sort: { new: "最新", title: "標題" },
};
export const WIDTH_LABELS: Record<string, Record<string, string>> = {
  sidebar: { s: "窄", m: "中" },
  center: { s: "窄", l: "寬" },
};

export const COMPONENT_LABELS = {
  stack: "堆疊", sidebar: "側欄", switcher: "並排", cards: "卡片格", cover: "主視覺", center: "置中",
  note: "筆記", tag_view: "標籤檢視", timeline: "時間軸",
  pattern_intro_now: "介紹＋近況", pattern_work_cards: "作品卡片", pattern_three_entries: "三欄入口", pattern_timeline: "時間軸區塊",
} as const;
export const CATEGORY_LABELS = { patterns: "範本", parts: "版面零件", content: "內容", modules: "模組" } as const;
