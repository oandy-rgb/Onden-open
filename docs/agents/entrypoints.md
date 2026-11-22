# 現有入口與設計資料

> 狀態：現行
> 涵蓋：packages/frontend/src/lib/appStore.ts, packages/contract/src/**, packages/backend/src/routes/sync.ts, scripts/allowlist-baseline.json

何時讀：不知道某個責任在哪個檔案，或需要找架構／研究文件時。已完成的審核報告在 [docs/archive/](../archive/README.md)。

## 現有入口與設計資料

以下是找責任的起點；文件可能落後於程式，涉及的行為須查實作與測試。唯一入口的清單另成 [entrypoints-catalog.md](entrypoints-catalog.md)（資料檔產生）。

- 「這件事該用哪個元件、函式、模組接口」：查 [entrypoints-catalog.md](entrypoints-catalog.md)（依需求分類；由 `scripts/entrypoints.catalog.json` 產生，以資料檔為準，不在這裡重複列）。
- 前端讀全域 store（`lib/appStore.ts`）：新程式用 appStore 匯出的**具名** hook／selector／動作（`useNode(id)`、`getNode(id)`、`addToast`、`setSelectedId`…）。
  寬入口 `getAppState`、`useAppSelector`、`setAppState`、`setData`、`subscribeApp` 由規則 `fe-app-store-reach` 管：`lib/appStore.ts` 與 `lib/data/**`（資料寫入層，擁有 store 的寫入）以外，
  既有檔案記在 `scripts/allowlist-baseline.json`（逐檔計數，只准減不准增，與 `be-raw-sql` 同為 `RATCHET_RULES`；外觀的 14 條規則也在其中，見 [appearance-rules.md](appearance-rules.md)），新檔案不能出現。
  需要的讀法沒有具名入口時，在 appStore 加一個**具名**窄 hook（如 `useSelectedId()`），不要在新檔案寫 `useAppSelector((s) => …)`。
  目的：之後 `data.nodes` 的形狀（例如改成 `{ byId, order }`）只改 appStore 一處。降基準：改完後跑 `npm run allowlist:baseline`。
- 同步路由：`packages/backend/src/routes/sync.ts`（寫入、讀取政策、復原、前端領域寫入的入口在清單的「後端」「共用邏輯」）。
- 前後端共用的資料形狀（API 契約）：`packages/contract`（`@onden/contract`，zod 與純型別；用法與守門見 `packages/contract/AGENTS.md`）。
  - 只有 `src/node.ts` 有執行期的 zod 結構：`ServerNode`（bootstrap、同步增量、`GET /api/nodes/:id` 送出的筆記）、`ServerNodeRow`（`POST`／`PATCH /api/nodes` 回的資料列，沒有標籤與事件欄位）、
    `DraftNode`（建立／修改筆記的請求內容，後端用它驗證），以及從 `ServerNode` 推導的 `ContentNode`（前端持有的筆記：只有核心欄位必有）。
    欄位新增或移除先改 `packages/contract/src/node.ts`；`packages/backend/src/test/nodeContract.integration.test.ts` 用 `.strict()` 解析真實回應，兩邊漂移就失敗。
  - 其他主題（AI 設定、備份還原、段落與引用、白板、bootstrap、歷史、匯入來源、分頁、發布預覽、複習、網站設定、空間、標籤、任務專注、垃圾桶、檢視列、筆記的頁面清單）一檔一個主題，**只有型別**，兩邊都用 `import type`，不在執行期解析。
    API 回應的實際形狀由 `packages/backend/src/test/apiContract.integration.test.ts` 記到 `packages/markdown/contract/api-shapes.json`，前端 `packages/frontend/src/test/apiContract.test.ts` 核對。
  - 後端的節點查詢以 `ServerNode`／`ServerNodeRow` 當型別（只在型別層級，不對每個請求 `parse`）；前端**只准 `import type`**（zod 不進開機包，`packages/frontend/scripts/check-boot-bundle.mjs` 會擋）。
- 功能地圖：[feature-map.md](../architecture/feature-map.md)。
- 全功能盤點：[full-feature-audit.md](../research/full-feature-audit.md)。後續盤點沿用案例 ID，更新證據、狀態與缺口；測試檔存在不等於已驗證。
- 發布後端屬於 website 模組：`packages/backend/src/modules/website/`（`publishing/` 為其內部；核心經 `services/publicSite.ts` 取用，不 import 模組）。
- 寫入契約：[note-writes.md](../architecture/note-writes.md)、[domain-writes.md](../architecture/domain-writes.md)、[website-writes.md](../architecture/website-writes.md)。
- 摘錄（帶來源的引用段落；RSS 劃線，之後 PDF）：[excerpts.md](../architecture/excerpts.md)；格式與解析只在 `packages/markdown/src/excerpt.ts`。
- 同步與權限集合：[sync-protocol.md](../architecture/sync-protocol.md)、[membership-and-permission-epoch.md](../architecture/membership-and-permission-epoch.md)。
- 修改功能模組前閱讀：[後端模組](../../packages/backend/src/modules/README.md)、[前端模組](../../packages/frontend/src/modules/README.md)。

### 2026-09-13　核心設計實測（歷史）

原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級；下面這條是當時的審查紀錄指標：

- 核心設計實測：[core-design-review-2026-09-13.md](../archive/core-design-review-2026-09-13.md)。
  已重現 node_type 政策旁路、鎖外授權／狀態判斷、空頁同步游標與 outbox 舊失敗結算問題；
  原審查保留缺陷證據；第十批已修復這五組問題，驗證及仍有限制見
  [core-design-fixes-2026-09-13.md](../archive/core-design-fixes-2026-09-13.md)。
