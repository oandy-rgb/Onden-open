// 「這一天」的項目：日子頁的直式時間軸、不限時間區與週檢視讀的同一種資料。
// 各來源（任務、修改、快速記錄、AI 執行、收工、專注）各自交出 DayItem；前後端共用這份型別、
// 「同一人連續修改合成一段」的規則，與時間軸上的位置計算（純函式，不認識時區——
// 呼叫者給的是已經換算好的「一天」起訖時刻）。
//
// 時間一律是 ISO 時刻（含時區）。任務的牆上時間（`HH:MM`）由呼叫者先換成時刻
// （frontend lib/dayWindow.ts 的 clockInstant），這裡不處理一天從幾點開始。
// 註：DayItem 在規格的欄位之外多了 `count`——合成一段時的筆記篇數，畫面用它組「改了 3 篇」。

export type DayItemKind = "task" | "edit" | "created" | "capture" | "agent" | "focus";

/** 時間軸（今天頁、日記右欄、3 天／週）只留「要做／做了的事」：任務與專注。
 *  修改、建立、快速記錄、AI 執行、收工在「歷史」看（業主 2026-10-31）。 */
export const TIMELINE_KINDS: readonly DayItemKind[] = ["task", "focus"];
export const onTimeline = (item: Pick<DayItem, "kind">): boolean => TIMELINE_KINDS.includes(item.kind);

/** 點項目要去哪裡：一篇筆記，或一個任務（任務的筆記就是它自己）。 */
export type DayItemRef = { type: "note" | "task"; id: string };

export type DayItem = {
  /** 開始時刻（ISO）；沒有＝不限時間。 */
  at?: string;
  /** 結束時刻（ISO）；沒有＝一個時間點。 */
  until?: string;
  kind: DayItemKind;
  title: string;
  /** 第二行：任務所在的筆記、這段改了哪幾篇…；不放數字統計。 */
  detail?: string;
  /** null: nothing to open (收工了). */
  ref: DayItemRef | null;
  /** 已經過去（畫面用淡色實底）；已完成的不限時間任務也算。 */
  past: boolean;
  /** 任務的勾選框：false 未完成、true 已勾；沒有＝沒有東西可勾。 */
  done?: boolean;
  /** 合成一段時涵蓋的筆記篇數。 */
  count?: number;
  /** 專注還在進行：`until` 是「現在」，畫面標成進行中。 */
  live?: boolean;
};

/** 一天的筆記（那天新增、存過、或 AI 動過的）：GET /api/day/:date/lens 的 bucket 列。 */
export type DayLensNote = { id: string; title: string; at: string };
/** 一個 bucket：最新的幾筆（伺服器有上限）和總數。 */
export type DayLensBucket<T> = { items: T[]; total: number };
/** GET /api/day/:date/lens 的回應（backend services/dayLens.ts 組、frontend modules/daily/day 讀）。
 *  筆記的分類放在 `buckets` 底下，不在最上層。 */
export type DayLens = {
  date: string;
  /** 時間軸的項目：修改段落、新增、AI 動過的。 */
  items: DayItem[];
  buckets: {
    created: DayLensBucket<DayLensNote>;
    edited: DayLensBucket<DayLensNote>;
    agent: DayLensBucket<DayLensNote>;
    /** 這天要做的任務（和有日期標籤的筆記），任務清單的列形狀。 */
    due: DayLensBucket<Record<string, unknown>>;
  };
};

/** 同一人連續修改之間隔小於這麼久，算同一段。 */
export const EDIT_RUN_GAP_MINUTES = 30;

export type DayEdit = { nodeId: string; title: string; at: string; actorId: string };

const ms = (iso: string) => Date.parse(iso);

/** 一天的修改紀錄合成「10:40–11:30 改了 3 篇」：同一個人、相鄰兩次修改間隔小於
 *  EDIT_RUN_GAP_MINUTES 的併成一段。只有一篇時用那篇的標題。回傳依開始時間排序。 */
export function mergeEditRuns(edits: readonly DayEdit[], nowMs: number, gapMinutes = EDIT_RUN_GAP_MINUTES): DayItem[] {
  const byActor = new Map<string, DayEdit[]>();
  for (const edit of edits) byActor.set(edit.actorId, [...(byActor.get(edit.actorId) ?? []), edit]);
  const items: DayItem[] = [];
  for (const own of byActor.values()) {
    const sorted = [...own].sort((a, b) => ms(a.at) - ms(b.at));
    let run: DayEdit[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const notes = new Map<string, string>();
      for (const e of run) notes.set(e.nodeId, e.title);
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const titles = [...notes.values()];
      items.push({
        at: first.at,
        ...(last.at !== first.at ? { until: last.at } : {}),
        kind: "edit",
        title: notes.size === 1 ? titles[0]! : "",
        ...(notes.size > 1 ? { detail: titles.filter((_, index) => index < 3).join("、") + (titles.length > 3 ? "…" : "") } : {}),
        ref: { type: "note", id: first.nodeId },
        past: ms(last.at) < nowMs,
        count: notes.size,
      });
      run = [];
    };
    for (const edit of sorted) {
      const prev = run[run.length - 1];
      if (prev && ms(edit.at) - ms(prev.at) >= gapMinutes * 60_000) flush();
      run.push(edit);
    }
    flush();
  }
  return sortDayItems(items);
}

/** 有時間的依時間排前面，不限時間的排後面；同時間保持原順序。 */
export function sortDayItems(items: readonly DayItem[]): DayItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const x = a.item.at, y = b.item.at;
      if (x && y) return ms(x) - ms(y) || a.index - b.index;
      if (x) return -1;
      if (y) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** 該標成過去：有時間的看結束（沒有結束看開始）是否早於現在；沒時間的由來源自己判斷（完成了沒）。 */
export function isDayItemPast(item: Pick<DayItem, "at" | "until" | "past">, nowMs: number): boolean {
  const end = item.until ?? item.at;
  return end ? ms(end) < nowMs : item.past;
}

/** 這一天的起訖時刻（毫秒）。一天不一定從 0 點開始，也不一定 24 小時（夏令時間）。 */
export type DayWindow = { startMs: number; endMs: number };

export type PlacedDayItem = {
  item: DayItem;
  /** 從一天開始算起的分鐘。 */
  topMinutes: number;
  heightMinutes: number;
  /** 與它重疊的項目並排時的欄位（0 起算）與總欄數。 */
  lane: number;
  lanes: number;
};

/** 一個沒有結束時間的項目在時間軸上佔多高（分鐘）。 */
export const POINT_ITEM_MINUTES = 30;

/** 把有時間的項目放到時間軸上，沒有時間的原樣分出去。
 *  不在這一天內的項目不放（落在邊界的會被截到範圍內）；重疊的並排成欄。
 *  `minMinutes`：沒有結束時間的項目（時間點）佔的時間，`heightMinutes` 也是這個值。
 *  `visualMinutes`：畫面上卡片最矮要佔的時間，只用來判斷重疊與分欄（畫面把短項目撐到這麼高，
 *  不分欄就會互相蓋住）；`heightMinutes` 仍是真實長度，呼叫者用它判斷「這是個短項目」。 */
export function layoutDayItems(
  items: readonly DayItem[],
  window: DayWindow,
  minMinutes = POINT_ITEM_MINUTES,
  visualMinutes = 0,
): { placed: PlacedDayItem[]; untimed: DayItem[] } {
  const untimed: DayItem[] = [];
  const raw: { item: DayItem; top: number; bottom: number; visualBottom: number }[] = [];
  const lengthMinutes = (window.endMs - window.startMs) / 60_000;
  for (const item of sortDayItems(items)) {
    if (!item.at) { untimed.push(item); continue; }
    const top = (ms(item.at) - window.startMs) / 60_000;
    const end = item.until ? (ms(item.until) - window.startMs) / 60_000 : top;
    // 只有「一個時間點」的項目撐到 minMinutes；有結束時間的保持真實長度（太短由 visualMinutes 處理）。
    const bottom = item.until ? Math.max(end, top) : top + minMinutes;
    if (bottom <= 0 || top >= lengthMinutes) continue;
    const clippedTop = Math.max(top, 0);
    raw.push({
      item, top: clippedTop, bottom: Math.min(bottom, lengthMinutes),
      visualBottom: Math.min(Math.max(bottom, clippedTop + visualMinutes), lengthMinutes),
    });
  }
  // 依開始排序後，貪心放進第一個放得下的欄；同一群互相重疊的共用欄數。
  const placed: PlacedDayItem[] = [];
  let group: { entry: (typeof raw)[number]; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const closeGroup = () => {
    for (const { entry, lane } of group) {
      placed.push({ item: entry.item, topMinutes: entry.top, heightMinutes: entry.bottom - entry.top, lane, lanes: laneEnds.length });
    }
    group = []; laneEnds = []; groupEnd = -Infinity;
  };
  for (const entry of raw) {
    if (entry.top >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= entry.top);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(entry.visualBottom); } else laneEnds[lane] = entry.visualBottom;
    group.push({ entry, lane });
    groupEnd = Math.max(groupEnd, entry.visualBottom);
  }
  closeGroup();
  return { placed, untimed };
}
