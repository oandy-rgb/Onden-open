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

const plainCache = new WeakMap();
/** 不是 uuid 的名字（媒體檔名、版本 id…）：整段字串取代。 */
function plainNames(names) {
  if (!plainCache.has(names) || plainCache.get(names).size !== names.size) plainCache.set(names, Object.assign(new Map([...names].filter(([k]) => k && k.length >= 6 && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(k))), {}));
  return plainCache.get(names);
}

/** @param {Map<string,string>} names uuid（或媒體檔名）→ 劇本裡的名字 */
export function normalizeValue(value, names, seenOrder, key = "") {
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
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, names, seenOrder, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const mapped = mapString(mapNamed(k));
      out[mapped] = COUNTER_KEYS.test(k) && typeof value[k] !== "object" ? "<n>" : normalizeValue(value[k], names, seenOrder, k);
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
  const seen = new Map();
  return log.map((entry) => {
    let body = entry.body;
    body = normalizeValue(body, names, seen);
    if (entry.unordered) body = sortLists(body);
    return { step: entry.step, status: entry.status, body };
  });
}
