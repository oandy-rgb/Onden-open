// What each part, template and module looks like and does, for the studio's
// 區塊 column: a small wireframe and one plain sentence. Kept here (not in the
// site registry) because only the studio shows it; the published site does not.
import type { ReactElement } from "react";

const W = 40;
const H = 28;

/** A 40×28 wireframe in `currentColor`; `filled` shapes are tinted, the rest outlined. */
function Wire({ children }: { children: ReactElement | ReactElement[] }) {
  return (
    <svg className="hs-wire" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.2">
      {children}
    </svg>
  );
}
const box = (x: number, y: number, w: number, h: number, filled = false) => (
  <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx="1.5" fill={filled ? "currentColor" : "none"} fillOpacity={filled ? 0.22 : 0} />
);
const line = (x1: number, y1: number, x2: number, y2: number) => <line key={`${x1}-${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} strokeLinecap="round" />;

const stack = () => <Wire>{[box(4, 3, 32, 5), box(4, 11, 32, 5), box(4, 19, 32, 5)]}</Wire>;
const sidebar = () => <Wire>{[box(3, 3, 11, 22, true), box(17, 3, 20, 22)]}</Wire>;
const switcher = () => <Wire>{[box(3, 5, 10, 18), box(15, 5, 10, 18), box(27, 5, 10, 18)]}</Wire>;
const cards = () => <Wire>{[box(4, 3, 14, 10), box(22, 3, 14, 10), box(4, 15, 14, 10), box(22, 15, 14, 10)]}</Wire>;
const cover = () => <Wire>{[box(2, 3, 36, 14, true), line(8, 22, 24, 22)]}</Wire>;
const center = () => <Wire>{[box(11, 3, 18, 22), line(15, 9, 25, 9), line(15, 14, 25, 14), line(15, 19, 22, 19)]}</Wire>;
const timeline = () => (
  <Wire>{[
    line(10, 3, 10, 25), <circle key="a" cx="10" cy="7" r="2" fill="currentColor" />, <circle key="b" cx="10" cy="14" r="2" fill="currentColor" />,
    <circle key="c" cx="10" cy="21" r="2" fill="currentColor" />, line(16, 7, 34, 7), line(16, 14, 30, 14), line(16, 21, 33, 21),
  ]}</Wire>
);
const workCards = () => <Wire>{[line(4, 4, 18, 4), box(4, 8, 10, 16), box(15, 8, 10, 16), box(26, 8, 10, 16)]}</Wire>;
const threeEntries = () => <Wire>{[box(3, 5, 10, 18, true), box(15, 5, 10, 18, true), box(27, 5, 10, 18, true)]}</Wire>;

const noteIcon = () => <Wire>{[box(9, 3, 22, 22), line(13, 9, 27, 9), line(13, 14, 27, 14), line(13, 19, 22, 19)]}</Wire>;
const tagList = () => <Wire>{[box(4, 4, 5, 5, true), line(13, 6.5, 36, 6.5), box(4, 12, 5, 5, true), line(13, 14.5, 32, 14.5), box(4, 20, 5, 5, true), line(13, 22.5, 34, 22.5)]}</Wire>;
const recent = () => <Wire>{[line(4, 5, 24, 5), line(4, 12, 30, 12), line(4, 19, 20, 19), box(30, 3, 7, 7, true)]}</Wire>;
const summary = () => <Wire>{[line(5, 6, 26, 6), line(5, 13, 35, 13), line(5, 19, 31, 19)]}</Wire>;
const pictureCard = () => <Wire>{[box(8, 3, 24, 22), box(8, 3, 24, 11, true), line(12, 19, 28, 19)]}</Wire>;
const titleOnly = () => <Wire>{[line(6, 14, 34, 14)]}</Wire>;

export type AssetInfo = { description: string; icon: () => ReactElement };

/** By component type (the site registry's names). */
export const ASSET_INFO: Record<string, AssetInfo> = {
  stack: { description: "由上往下一個接一個", icon: stack },
  sidebar: { description: "左邊窄欄放介紹，右邊放主要內容", icon: sidebar },
  switcher: { description: "幾個東西左右並排", icon: switcher },
  cards: { description: "自動排成卡片格子", icon: cards },
  cover: { description: "頁首的大標題區", icon: cover },
  center: { description: "內容置中、窄一點好讀", icon: center },
  pattern_intro_now: { description: "左邊一段自我介紹，右邊列出最近的筆記", icon: sidebar },
  pattern_work_cards: { description: "把一個標籤的筆記排成作品卡片", icon: workCards },
  pattern_three_entries: { description: "三張並排的入口卡，各連到一篇筆記", icon: threeEntries },
  pattern_timeline: { description: "依日期列出筆記的一段", icon: timeline },
  timeline: { description: "依日期列出筆記", icon: timeline },
};

/** The content and text kinds the 區塊 column offers, by their own ids (one component type can have several, with different starting props). */
export const KIND_INFO: Record<string, { label: string; description: string; icon: () => ReactElement }> = {
  note: { label: "一篇筆記", description: "把一篇筆記放上網站", icon: noteIcon },
  tag_view: { label: "標籤的筆記", description: "把有同一個標籤的筆記列成清單", icon: tagList },
  recent: { label: "最近的筆記", description: "列出一個標籤最新的幾篇", icon: recent },
  summary: { label: "筆記摘要", description: "只放一篇筆記的第一段", icon: summary },
  picture_card: { label: "圖文卡片", description: "封面圖加一小段文字，點了進筆記", icon: pictureCard },
  title_only: { label: "只有標題", description: "一行標題，點了進筆記", icon: titleOnly },
};
