# 導覽列、「更多」與建立選單

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：packages/frontend/src/settings/NavigationSetting.tsx, packages/frontend/src/lib/navLayout.ts, packages/frontend/src/lib/createKinds.ts, packages/frontend/src/lib/sidebarFlatten.ts, packages/frontend/src/components/PlacePicker.tsx

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-10-25、10-29（業主決定，2026 年） |
| 實作狀態 | **已實作** |

## 決定

導覽列沒有白板入口，白板從建立選單開（10-25）。「更多」就是導覽的編輯清單（10-29）。

## 空的空間也要有第一步（2026-11-17，業主）

剛建好、還沒有筆記的空間照樣出現在側欄（標題＋「還沒有筆記」＋「＋」，按了在那個空間最上層建立筆記）；選位置清單輸入空間名稱找得到，結果是「空間 › 最上層」；空間設定頁有「在這個空間新增筆記」。理由：空的空間不顯示，新使用者建完空間就沒有地方放第一則筆記。

## 為什麼

導覽列空間有限，只放常用；其餘入口集中在一個可編輯的清單。

## 例外

—

## 相關檔案與狀態備註

- packages/frontend/src/settings/NavigationSetting.tsx：設定 › 導覽列，唯一的導覽編輯畫面（手機「更多」裡的「編輯」開同一個），版面規則在 `lib/navLayout.ts`。
- 白板在建立選單：`lib/createKinds.ts` 有 `canvas` 這一種（標籤「Canvas」，依白板模組是否開啟）；2026-11-17 核對 `lib/navLayout.ts` 的預設釘選（`DEFAULT_PHONE_PINS`＝任務）沒有白板。
- changes/2026-10-31-one-nav-editor-inbox-tab.md
