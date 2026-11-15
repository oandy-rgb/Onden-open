// 各區共用的小工具。劇本的每個區（areas/*.mjs）都長一樣：`export async function 某區(api, ctx)`。
// 取不到 id 時不丟錯（丟錯會讓後面全部步驟都沒跑），而是回 null；那一步的回應照樣被記下來、被比對。
export const idOf = (res) => (typeof res?.body?.id === "string" ? res.body.id : null);

/** 登記名字；沒有 id 就略過。 */
export function nameIf(api, label, id) {
  if (typeof id === "string" && id) api.names.set(id, label);
  return id ?? null;
}

/** 固定的冪等鍵（每個宿主都送一樣的，劇本才可重現）。 */
export const KEY = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** 建一篇筆記並登記名字；回 id（失敗回 null）。 */
export async function makeNote(api, step, label, body = {}, headers) {
  const res = await api.call(step, "POST", "/api/nodes", { json: body, headers });
  return nameIf(api, label, idOf(res));
}

/** 回應是不是劇本自己建立的東西（名字登記過）。 */
export const mine = (api) => (id) => typeof id === "string" && api.names.has(id);

/** 宿主不可能一樣的欄位（隨機權杖、時間）換成固定標記。 */
export const maskKeys = (keys) => (value) => {
  const walk = (v) => Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.includes(k) ? "<masked>" : walk(x)])) : v;
  return walk(value);
};

// 一張 1x1 PNG；內容固定，三個宿主上傳同樣的位元組。
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** 備份／匯出檔裡各宿主不同、與行為無關的字：媒體檔名（內容雜湊或隨機 id）、桌面版視窗自己先建的今日日記造成的 slug 後綴。 */
export const scrubText = (text) => String(text)
  .replace(/[0-9a-f]{32}(?=\.\w+)/g, "{media}")
  .replace(/\/api\/media\/[^\s)"]+/g, "/api/media/{media}")
  .replace(/^(slug: \d{4}-\d{2}-\d{2})-\d+$/gm, "$1")
  .replace(/^(\s*"slug": ?"\d{4}-\d{2}-\d{2})-\d+"/gm, '$1"')
  .replace(/("slug": ?"\d{4}-\d{2}-\d{2})-\d+"/g, '$1"')
  .replace(/ink-[0-9a-f-]+-(\d+\.svg)/g, "ink-{id}-$1");
export const scrubPath = (path) => scrubText(path).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{uuid}");
