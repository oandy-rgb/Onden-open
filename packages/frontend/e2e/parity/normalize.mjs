// 把一個宿主的紀錄正規化：由宿主產生的 id 換成劇本裡的名字、拿掉時間戳與版本號、無序的清單排序。
// 比對的是「行為」，不是「哪個宿主剛好給了哪個流水號」。
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
// 文字裡夾的時間（備份檔的 front matter 寫 "2026-11-06 10:03:40.678+00"）。
const TIME_IN_TEXT = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g;
// 值是計數器或內容雜湊，每個宿主不同：留 key、拿掉值。
const COUNTER_KEYS = /^(last_event_id|membership_epoch|event_id|eventId|cursor|version|etag|body_hash|base_hash|hash|sha256|checksum|build|build_id)$|_(event_id|cursor|epoch|hash)$/;
const TIME_KEYS = /(^|_)(at|time|timestamp|date_time|server_time)$/;
const STABLE_TIME_KEYS = /^(when_date|deadline|until|date|day|completed_on)$/; // 劇本自己指定的日期，不能當時間戳拿掉

// Position fields are orderings, not values; each is replaced by its rank among the values the script observed on this host.
// A rank keeps "A is before B" and "A and B are tied" and drops the rest. What is dropped, and why it may be:
//   order_stamp  the clock reading of the write that set the key (migration 200: 15-digit wall ms + 6-digit counter), so it
//                differs on every run by construction. One clock per host: one ranking over the whole log.
//   order_key    a function of the siblings around it (append = after the last live sibling), and a host can have siblings the
//                script did not make (the desktop window opens today's note by itself, the browser version ships sample notes),
//                so the text shifts. A key stays valid between moves, so one ranking per sibling group (same parent_id) over
//                the whole log.
//   sort_order   the rank among ALL siblings at the moment of one backup (services/backupArchive.ts): a snapshot, not a stable
//                value, so ranked among the values of that one response only.
// Rank, not the text: the order is what a person sees; the key text is not.
const ORDER_FIELD = { order_key: "key", sort_order: "rank", order_stamp: "stamp" };
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // byte order like COLLATE "C", never a locale
const byNumber = (a, b) => a - b;
const groupOf = (obj) => (typeof obj.parent_id === "string" ? obj.parent_id : "");

/** Ranks of the position values of the given kinds that appear in `bodies`; `of` is null for a value it did not observe
 *  (an empty stamp, a null sort_order), which then stays as it is. */
function observedRanks(bodies, kinds) {
  const seen = { key: new Map(), rank: new Map(), stamp: new Map() };
  const add = (kind, group, x) => { if (!seen[kind].has(group)) seen[kind].set(group, new Set()); seen[kind].get(group).add(x); };
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      const kind = ORDER_FIELD[k];
      if (!kinds.includes(kind)) walk(x);
      else if (kind === "stamp" ? typeof x === "string" && x !== "" : typeof x === (kind === "rank" ? "number" : "string")) add(kind, kind === "stamp" ? "" : groupOf(v), x);
    }
  };
  bodies.forEach(walk);
  const tables = Object.fromEntries(Object.entries(seen).map(([kind, groups]) => [kind,
    new Map([...groups].map(([g, set]) => [g, new Map([...set].sort(kind === "rank" ? byNumber : byText).map((x, i) => [x, i]))]))]));
  return { of: (kind, obj, x) => tables[kind].get(kind === "stamp" ? "" : groupOf(obj))?.get(x) };
}

const plainCache = new WeakMap();
/** 不是 uuid 的名字（媒體檔名、版本 id…）：整段字串取代。 */
function plainNames(names) {
  if (!plainCache.has(names) || plainCache.get(names).size !== names.size) plainCache.set(names, Object.assign(new Map([...names].filter(([k]) => k && k.length >= 6 && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(k))), {}));
  return plainCache.get(names);
}

/** @param {Map<string,string>} names uuid（或媒體檔名）→ 劇本裡的名字 */
export function normalizeValue(value, names, ranks, key = "") {
  const mapString = (s) => s.replace(UUID, (id) => {
    if (names.has(id)) return `{${names.get(id)}}`;
    // 劇本沒命名的 id（內建標籤、檢視、成員…）是各宿主自己產生的，位置會因範例資料而移動，所以不編號。
    return "{uuid}";
  });
  const mapNamed = (s) => { let out = s; for (const [from, to] of plainNames(names)) if (out.includes(from)) out = out.split(from).join(`{${to}}`); return out; };
  if (typeof value === "string") {
    if (ISO.test(value) && !STABLE_TIME_KEYS.test(key)) return "<time>";
    return mapString(mapNamed(value)).replace(TIME_IN_TEXT, "<time>");
  }
  if (typeof value === "number") return COUNTER_KEYS.test(key) || (TIME_KEYS.test(key) && value > 1e11) ? "<n>" : value;
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, names, ranks, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const mapped = mapString(mapNamed(k));
      const position = ORDER_FIELD[k] ? ranks.of(ORDER_FIELD[k], value, value[k]) : undefined;
      out[mapped] = position !== undefined ? `<${ORDER_FIELD[k]} #${position}>` : (COUNTER_KEYS.test(k) && typeof value[k] !== "object" ? "<n>" : normalizeValue(value[k], names, ranks, k));
    }
    return out;
  }
  return value;
}

const sortKey = (v) => JSON.stringify(v);
/** 無序的清單（步驟標了 unordered）遞迴排序；其餘維持伺服器給的順序。 */
export function sortLists(value) {
  if (Array.isArray(value)) return value.map(sortLists).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sortLists(v)]));
  return value;
}

/** 一個宿主的整份紀錄 → 逐步的正規化結果 [{ step, status, body }]。 */
export function normalizeLog(log, names) {
  const overLog = observedRanks(log.map((entry) => entry.body), ["key", "stamp"]);
  return log.map((entry) => {
    const inThisStep = observedRanks([entry.body], ["rank"]);
    const ranks = { of: (kind, obj, x) => (kind === "rank" ? inThisStep : overLog).of(kind, obj, x) };
    let body = entry.body;
    body = normalizeValue(body, names, ranks);
    if (entry.unordered) body = sortLists(body);
    return { step: entry.step, status: entry.status, body };
  });
}
