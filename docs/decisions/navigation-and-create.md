# 導覽列、「更多」與建立選單

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：packages/frontend/src/settings/NavigationSetting.tsx, packages/frontend/src/lib/navLayout.ts, packages/frontend/src/lib/createKinds.ts

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-25、10-29（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

導覽列沒有白板入口，白板從建立選單開（10-25）。「更多」就是導覽的編輯清單（10-29）。

## 為什麼

導覽列空間有限，只放常用；其餘入口集中在一個可編輯的清單。

## 例外

—

## 相關檔案與狀態備註

- packages/frontend/src/settings/NavigationSetting.tsx：設定 › 導覽列，唯一的導覽編輯畫面（手機「更多」裡的「編輯」開同一個），版面規則在 `lib/navLayout.ts`。
- 白板在建立選單：`lib/createKinds.ts` 有 `canvas` 這一種（標籤「Canvas」，依白板模組是否開啟）；2026-11-17 核對 `lib/navLayout.ts` 的預設釘選（`DEFAULT_PHONE_PINS`＝任務）沒有白板。
- changes/2026-10-31-one-nav-editor-inbox-tab.md
