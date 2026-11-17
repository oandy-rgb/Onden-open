# 提案：已發布筆記改名後，舊網址不再 404（GAP-240）

> 狀態：歷史紀錄（寫於 2026-11-04；現況見 packages/backend/src/modules/website/publishing/siteRedirects.ts）

狀態：**業主 2026-11-05 選 B，四題都照建議（slug 80 字、轉址上限 1000、標籤頁同批）；已實作**，見 §7。引用的路徑以 `packages/` 為根。

## 1. 問題

- 筆記的 slug 一律跟著標題（`backend/src/services/nodes.ts:86` `slugFor`，D55 定下「slug 跟著標題只有一個負責的地方」）。
- 發布時快照凍結當下的 slug（`backend/src/modules/website/publishing/snapshot.ts` `frozenPublishedNodes`，撞名時 `publishedSet.ts:144` 加 `-<id6>`）。
- 公開站只認快照裡的 slug，找不到就回 404（`frontend/src/pages/site/[slug].astro:28`）；靜態輸出（zip／Pages）也只有現行 slug 的頁（`frontend/src/lib/siteStatic.ts:11` `sitePagePaths`）。
- 所以：把已發布的筆記改名 → 下次發布 → 外部連結、書籤、搜尋引擎收錄的舊網址全部 404，介面沒有任何提示。網站用途是數位花園／部落格（[發布改版](publish-redesign-2026-10-24.md) §1），穩定網址是基本期待。
- 另外 `slugify`（`markdown/src/slug.ts:17`）沒有長度上限：長標題得到很長的網址。
- 標籤頁 `/site/tag/<slug>/` 改名也是同一個問題。
- 已經沒問題的部分：RSS 的 `guid` 是筆記 id（`frontend/src/pages/site/_feedResponse.ts:35`），改名不會讓訂閱者看到重複的文章。

## 2. 契約（兩個方案都要滿足）

1. 曾在某次發布中出現過的網址，只要那篇筆記（或標籤）現在仍在公開站上、而且從那次起每一次發布都還在網站上（中間下架過就不算，見 §7），就要能到達它：線上回 **301** 到現行網址；靜態輸出放一頁轉址頁（`<meta http-equiv="refresh">` 加 `<link rel="canonical">` 加一個普通連結，因為 GitHub Pages 沒有伺服器端轉址）。
2. 筆記被取消發布、下架、刪除或移到不能發布的空間後，它的舊網址回 404，**不轉址也不透露新網址**。新網址裡有標題，可能洩漏內容。
3. 一個舊網址被另一篇現行頁面用掉時，現行頁面優先，那條轉址作廢。
4. sitemap、canonical、站內 `[[連結]]`、「複製連結」都只用現行網址。轉址頁不進 Pagefind 索引、不進 sitemap。
5. 不改 App 內的 slug 規則（D55 不動）：只處理「公開站上看到的網址」。

## 3. 方案

### A. 網址在第一次發布時固定（之後改名不換網址）

做法：發布時，對上一份快照裡已有的筆記沿用它在那份快照的 slug；新上站的筆記才用現在的 slug。

```ts
// snapshot.ts（草圖）
const previous = await latestSnapshotSlugs(workspaceId);   // Map<nodeId, slug>
for (const row of nodes.rows) row.slug = previous.get(row.id) ?? row.slug;
await uniquePublishedSlugs(nodes.rows);
```

- 優點：改動最小。不必產生轉址頁，網址真的不變。
- 缺點：
  - 網址永遠停在第一次發布時的標題，打錯字或「未命名」也一樣，想換只能另做「更改網址」功能，而那又需要轉址，等於回到 B。
  - App 內的「複製連結」與站上網址會長期不同。
  - 筆記取消發布後再發布，上一份快照沒有它，就會拿到新網址，舊連結還是斷。要可靠，得往前翻所有歷史快照，或另存一張表。
  - 和 D55「slug 跟著標題」的直覺相反，使用者看不出網址為什麼是舊標題。

### B. 網址跟著標題，舊網址自動轉址（建議）

做法：快照多一個 `redirects`，內容是「舊 slug → 筆記 id」。發布時由上一份快照推出來：

```ts
// 型別（payload 新欄位；舊快照沒有就當空）
type SiteRedirects = { notes: Record<string /* old slug */, string /* node id */>; tags: Record<string, string /* tag id */> };

// snapshot.ts（草圖）：新快照的 redirects ＝ 上一份的 redirects ＋ 這次換掉的 slug
function nextRedirects(prev: { slugs: Map<string, string>; redirects: SiteRedirects["notes"] },
                       now: Array<{ id: string; slug: string }>): SiteRedirects["notes"] {
  const live = new Set(now.map((n) => n.slug));
  const out: Record<string, string> = {};
  for (const [slug, id] of Object.entries(prev.redirects)) out[slug] = id;
  for (const [id, slug] of prev.slugs) out[slug] = id;          // 上一份的現行網址也成為候選
  for (const slug of Object.keys(out)) if (live.has(slug)) delete out[slug]; // 契約 3：現行頁面優先
  return capOldest(out, 1000);                                    // 上限，超過丟最舊的
}
```

- **讀取端**：`[slug].astro` 找不到現行頁時，查 `redirects.notes[slug]`。目標 id 在現行已發布集合（已扣掉下架）裡才 301 到 `sitePathFor(id)`，否則照舊 404（契約 2）。`tag/[slug].astro` 同理。
- **輸出端**：`sitePagePaths` 之外多一份 `siteRedirectPaths`，靜態輸出把每條寫成轉址頁，加上 `data-pagefind-ignore` 並排除在 sitemap 之外（契約 1、4）。
- **下架**：`republishSite` 不建新快照，讀取時「目標不在現行集合就 404」已經涵蓋，不必改寫快照。
- **長度上限**：一併給 `slugify` 加上限（建議 80 字，切在字的邊界）。既有的長網址會在下次發布時變短，舊的長網址由同一套轉址接住，不會斷。
- 優點：
  - 網址永遠反映現在的標題，和 App 內一致；舊連結全部接得住。
  - 資料只多快照裡的一個欄位，不用新表也不用 migration（快照 payload 是 JSON）。（實作時更正：取消發布後再發布**接不回**舊網址，見 §7 第一點。）
- 缺點：
  - 要改讀取、輸出、sitemap、搜尋四個出口（都有現成的單一入口）。
  - 轉址清單會累積，所以設上限。
  - 靜態主機只能用 meta refresh，搜尋引擎多一跳。

### C.（不建議單獨做）讓使用者手動指定網址

在筆記上加一個「網址」欄位，自訂後不跟著標題。這是 A 的「更改網址」，同樣需要 B 的轉址才不會斷鏈。可以等 B 上線、真的有需求時再加，B 的資料結構直接沿用。

## 4. 建議

**採 B。** 它是唯一同時滿足「網址跟著標題」（D55）與「舊連結不斷」的做法，也不需要新資料表。A 看似簡單，但取消發布再發布、想改網址這兩個常見情況都會逼出 B。

## 5. 驗證（B）

- 單元測試：
  - `nextRedirects`：改名、改回原名、A 與 B 互換名字、舊網址被新頁占用、上限。
  - `slugify` 的長度上限，並維持 `slugify(slugify(x)) === slugify(x)`。
- 整合測試（PG）：
  - 發布、改名、再發布：舊網址 301 到新網址。
  - 取消發布後，舊網址與新網址都回 404，回應裡不含新網址。
  - 改名後取消發布：舊網址回 404；下一次發布的快照不再提到它；再發布時從現行網址開始（實作時更正，見 §7）。
- 前端：`[slug].astro`、`tag/[slug].astro` 的 301 與 404、轉址頁不進 sitemap 與 Pagefind。
- 靜態輸出：`staticSite.test.ts` 檢查轉址頁存在、用相對路徑、`file://` 可開。
- e2e：`sitePages.spec.ts` 加一個「改名再發布，舊網址到得了」的案例。

## 6. 要業主決定

1. A 或 B（建議 B）。
2. slug 長度上限 80 字可以嗎？
3. 轉址清單上限 1000 條、超過丟最舊的，可以嗎？
4. 標籤頁要不要同一批做？建議同一批做，機制相同。

## 7. 實作紀錄（2026-11-05）

- **與原提案不同：下架後舊網址作廢，不會在再發布時接回。**
  - 原提案說「取消發布再發布也接得回來」，做法是讓轉址清單一路帶著已下架筆記的 `{ slug, id }`。
  - 但這違反既有的隱私保證：下架後建的快照不得再提到那篇筆記，包括它的 id，以及含有標題的 slug。後端 PGlite 完整套件的 `publishRedaction.property.integration.test.ts` 抓到了這個問題。
  - 改成 `nextRedirects` 只保留新快照裡仍在網站上的筆記與標籤的舊網址。代價是筆記下架後，那些舊網址永遠回 404。

- **slug 上限**：`markdown/src/slug.ts` 的 `SLUG_MAX = 80`，以字（grapheme）計、切在字的邊界、去掉結尾的 `-`，仍冪等。上限前存下的長 slug 不改，下次改名才變短，舊網址由轉址接住。
- **快照**：`backend/src/modules/website/publishing/siteRedirects.ts`。
  - `snapshotRedirects` 在發布交易中讀上一份快照：它的 `redirects`、各筆記的 id／slug、`tag_pages` 的 id／slug，只取這些，不讀正文。
  - `nextRedirects`（純函式）推出新的清單，由 `buildCandidate` 寫進 `payload.redirects = { notes, tags }`。沒有任何轉址時不寫。
  - 每筆存成 `{ slug, id }` 物件，所以永久刪除時 `purgedContent.withoutNodes` 會連同舊網址一起清掉。
- **公開站**：`servedSite.applyTakedown` 在下架之後用 `servedRedirects` 換成 `payload.site_redirects = [{ from, to }]`，只留目前仍在網站上的筆記與標籤頁，並刪掉原本的 `payload.redirects`，所以存下的 id 不會送出伺服器。
- **前端**：
  - `lib/siteRedirects.ts`（`siteRedirectsOf`、`movedTo`）只接受 `/site/` 開頭的位址，不會轉到外部網站。
  - `pages/site/[slug].astro` 與 `tag/[slug].astro` 找不到頁時查轉址，有就 301，Location 經百分比編碼。
  - `static-pages.json` 多一個 `redirects`。
- **靜態輸出**：`staticSite.ts` 為每條轉址寫一頁 `redirectPage`：meta refresh 與連結都用相對路徑，canonical 指向現行網址（Pages 會換成 Pages 網址），另外加 `noindex`、`data-pagefind-ignore` 與 meta CSP。轉址頁不覆蓋任何現有頁面。sitemap 只列現行頁。
- **測試**：
  - `markdown/src/slug.test.ts`
  - `backend/src/test/siteRedirects.test.ts`（14 項，含永久刪除）
  - `staticSite.test.ts`（多 4 項）
  - `frontend/src/lib/siteRedirects.test.ts`
  - `siteRedirects.integration.test.ts`（改名再發布、之後的發布延續、下架後不洩漏也不再提到、再發布從現行網址開始、新頁占用舊網址、永久刪除）已在 PGlite 上通過；需要真 Postgres 的部分（沒有）不適用。e2e `sitePages.spec.ts` 結果見 PR／後續紀錄。
- **實測**：真實建置的 Astro SSR 搭配模擬的 `/api/site`：
  - `/site/plan`、`/site/plan/`、中文舊網址、`/site/tag/books/` 都回 301 到現行頁。
  - 不存在的頁回 404；現行頁回 200。
  - sitemap 不含舊網址。

