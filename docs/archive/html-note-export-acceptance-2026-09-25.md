# 單筆 HTML 匯出隔離瀏覽器補驗（2026-09-25）

> 狀態：歷史紀錄（最後確認 2026-11-01）

對應 NOTE-13、GAP-62、GAP-63，以及 GAP-65 的 HTML 指令文案。來源為
`c930137`；本批只更新 E2E 案例及紀錄，沒有修改產品程式。

使用 `compose.e2e.yaml` 的 `onden_test` PostgreSQL、當前後端／前端映像、
`127.0.0.1:5100`，Playwright 1.60.0 無頭 Chromium、單一 worker。
全域 setup 建立隔離 owner 測試帳號；案例只對它新建的筆記操作，沒有改正式 localhost。
服務在驗證後已停止，測試 volume 保留供後續隔離重驗。

| 步驟 | 預期與實際 |
| --- | --- |
| `GET /api/nodes/:id/export.html` | 200，attachment HTML 含正文、inline CSS 與工作區自訂 CSS；通過。這推翻先前隔離後端仍回 404 的舊觀察，沒有驗證正式部署。 |
| 桌面指令面板 `Export this note as HTML` | 真實點擊後取得 `.html` 下載；通過。舊測試仍尋找 `Export note as HTML`，初跑 15 秒逾時；按畫面現行文案修正 selector 後通過。 |
| `POST /api/nodes/:id/export-preview` | 傳入與已存正文不同的標題、草稿正文，回應 HTML 含草稿；再 GET 節點仍是原標題／正文；通過。未核對事件表。 |
| 320×500 筆記更多選單 | 選單矩形左右都在 viewport 內，展開匯出子選單可點 HTML；下載 `.html` 內容包含該筆正文；通過。 |

先前 2 項執行為 1 通過、1 因過期 selector 失敗；修正後重跑該項 1 通過，
新增預覽與 320px 案例 2 通過。最終四項相關案例各自通過。
可重現紀錄、Playwright JSON 與舊失敗畫面置於 gitignored 的
`.acceptance/2026-09-25/gap-47-63/`；前後端映像與上一批 `c930137` 的產品來源相同。
同批提交前，後端匯出專項 1 檔／7 項、前端匯出與選單 2 檔／34 項通過；
兩端 typecheck／lint 及前端 build 通過。測試與 build 依序執行。

本輪沒有驗證真實 PDF 列印／取消、HTML 內的私有媒體、離線連線失敗、
權限拒絕、剪貼簿拒絕或真機；NOTE-13 仍為「部分」。GAP-62 的 HTML 轉換與
草稿不落盤子情境已重驗，PDF 子情境仍待驗。GAP-63 的 320px HTML 選單與
下載已重驗，其他入口與真機限制見原始盤點。GAP-65 只解決 HTML 指令文案
這一個測試契約，其他 fixture 問題未關閉。
