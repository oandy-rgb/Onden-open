# 資訊欄的精簡歷史與浮動比較視窗（2026-09-29）

> 狀態：歷史紀錄（最後確認 2026-11-01）

起點 `569992f`，實作提交 `7795c3e`。本批使用案例：正文保持開啟，從右側筆記資訊底部查看最近版本，
點選即在浮動視窗比較／還原，關窗後繼續原筆記。取代先前編輯區上方的內容／歷史整列。
本輪不推進全功能盤點狀態；沿用 7 已盤、114 部分、30 待盤、12 需環境。

## 入口與責任

- 桌面移除中央 context bar；資訊與隱藏側欄開關移到既有頂列，關閉／focus／舊 collapsed 偏好皆能重新開啟。
- 資訊欄底部只列最近三筆版本的日期、作者與保存次數；點列直接預選該版本，完整歷史開啟全部版本。
  不再重複標題、展開正文或提供行內還原。桌面上方資訊獨立捲動，底部不覆蓋正文；手機按內容自然堆疊。
- 手機由 Info 進入最近版本，移除 History 分頁；條件式 Canvas／Table 與 Content 仍由手機頂欄提供。
  桌面特殊筆記的 Canvas／Table 切換位於資訊欄，普通筆記不顯示多餘 Content 按鈕。
- 舊 `lens=timeline`、`view=timeline` 與指令面板的歷史／工作區歷史仍保留事件、垃圾桶及範圍切換，
  舊歷史頁不重複在右側放版本清單。一般筆記的最近版本入口不切換中央頁面。

比較兩種組裝方式：讓 `NodeInspector` 接收所有 lens 狀態、路由與版本操作，或只接受 `footer` 內容。
選後者：Builder 組裝目前筆記的支援操作，Inspector 只負責上下區塊與捲動；
`NoteVersionHistory` 繼續擁有視窗開關、快照與共用 `useVersionRestore`，不把保存知識搬到外殼。

`HistoryView.initialVersionId` 是可選的開窗預選；未指定沿用最近版本，無效 ID 也回到最近版本。
開窗當下先捕捉版本清單，再載入 lazy dialog，避免等待期間的 session 合併改換使用者點選的版本。
Current 持續讀目前草稿，重新開窗才取得新清單。還原先保存草稿、拒絕保留視窗及目標等契約不變。

## GAP-90：舊還原回應關閉新視窗

重現：A 筆記視窗開始還原並等待，外部切到 B 並開啟 B 歷史，A 回應成功。
原無條件 `setHistory(null)` 會關掉 B 的新視窗。先加入回歸得到 1 項失敗，再把關閉綁定到本次
opening 身分，只允許原視窗清除自身。這不改變 writer 的寫入結果或跨重載冪等契約。

證據目錄 `.acceptance/2026-09-29/inspector-history/`：`agent-unit-red.log` 保留失敗重現；
`unit-history.log` 為相關 2 檔／12 項通過，涵蓋快照、合併、預選、拒絕重試、live draft、
切換筆記、關窗焦點及晚到回應。外殼相關 3 檔／19 項通過（`shell-unit.log`）。

## 瀏覽器與部署

驗證使用獨立 `onden-history` stack、`onden_test`、localhost:5100、owner fixture，
正式資料不參與測試。Chromium 單 worker、1 CPU／1 GiB；手機為 viewport，非真機。
最終相關 Chromium 6 檔／27 項全數通過，零重試、零跳過（`e2e.log`）。
包含 1920／1440／1280／901／768／390／320px、中文／英文、資訊欄重開、
Canvas／Table、手機格式工具、保存重載、版本比較、鍵盤、還原與舊 URL。
其中最近版本的還原注入一次 503：視窗及所選版本保留，正文未被改寫，
重試沿用同一 Idempotency-Key，成功後編輯器與 API 皆為目標版本。

逐張檢視桌面淺色1280px、中文901px、深色空白筆記1920px與完整比較視窗。
第一組手機截圖的頂欄位置值得檢查，補上關窗後導覽列必須在 viewport 內的斷言；
該既有案例再跑 1 項通過，最終320px截圖確認返回正文／Info均可見（`mobile-return.log`、
`mobile-return-output/`），不另累加測試數。補跑第一次因輸出目錄權限未啟動瀏覽器案例，
已修正測試目錄並保留 `mobile-runner-permissions.log`，不是產品測試失敗。

前後端 TypeScript／lint、前端 build 通過；相關單元合計 5 檔／31 個不同案例。
E2E 全清單僅收集為137檔323項（Chromium303、其他引擎20），不是全套執行。
未重跑全庫單元、完整後端整合、Firefox／WebKit或163項完整驗收。

部署版本與只讀 smoke 另記於[VPS部署紀錄](vps-tailscale-http-2026-09-28.md)。


2026-09-29 01:54（台北）已將 `7795c3e` 套用VPS，DB/content備份checksum、
四服務健康、實際CSS產物核對及工作機只讀Tailnet smoke均通過。
隔離服務與資料卷已清理（`cleanup.log`），本輪沒有在正式站新增測試資料。
