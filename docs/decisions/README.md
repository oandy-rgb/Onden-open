# 產品決定

> 狀態：現行（最後確認 2026-11-17）
> 涵蓋：docs/decisions/*.md

結論：這裡記業主做過的產品決定，一個決定一個短檔（決定、為什麼、日期、例外、相關檔案）。
2026-11-01 依對話記錄整理並**對照程式碼**（2026-11-17 重新核對其中幾份，各檔寫明依據）：「與程式不符」或「尚未實作」的寫在各檔的最後一節。
新決定請加一個檔並更新下表；不要把決定只留在對話裡。

實作狀態：**已實作**＝已對照程式；**實作中**＝部分做了或有與決定不符之處；**尚未實作**＝只是決定；
**已定案（未逐項對照程式）**＝原則性決定，沒有單一程式位置可驗證。

| 決定 | 日期 | 實作狀態 |
| --- | --- | --- |
| [AI 不預設模型](ai-no-default-model.md) | 2026-10-14 | 已實作 |
| [AI 中立：介面與文件不出現商家／產品名](ai-neutral.md) | 2026-11-01 | 已實作 |
| [加入 AI 角色只有 API 與 MCP 兩種；API 只能提建議](ai-runtimes.md) | 2026-11-01 | 已實作 |
| [AI 整個是可以關掉的模組](ai-is-a-module.md) | 2026-11-01 | 已實作 |
| [產品原則：鼓勵輸出、不鎖住資料；捕捉無摩擦、之後消化](product-principles.md) | 2026-10-18 | 已定案（未逐項對照程式） |
| [沒有功能凍結；每個新功能都是可關閉的模組](no-feature-freeze.md) | 2026-10-23（11-01 補充） | 實作中 |
| [介面不放技術細節](ui-no-technical-details.md) | 2026-10-23 | 已實作 |
| [「隱藏」只用在標籤](hide-only-tags.md) | 2026-10-19 | 已定案（未逐項對照程式） |
| [沒有垃圾桶：軟刪除＋復原提示＋從歷史還原](soft-delete-no-trash.md) | 2026-10-19（10-30 補充） | 已實作 |
| [標籤模型](tag-model.md) | 2026-10-18、10-24、10-30 | 已定案（未逐項對照程式） |
| [身分只有擁有者與成員；擁有者逐空間設定成員](identity-owner-member.md) | 2026-10-22（10-18 邀請） | 已實作 |
| [登入不用驗證碼；用真實 IP 限速](login-no-code-real-ip.md) | 2026-10-24 | 已實作 |
| [別人可以自架；發行版來自 main；公開發布要乾淨](self-host-and-release.md) | 2026-10-24 | 實作中 |
| [閱讀只留 RSS；摘錄模型](reading-rss-excerpts.md) | 2026-10-18、10-29 | 實作中 |
| [發布時查詢／資料庫區塊凍結成快照](publish-freezes-queries.md) | 2026-10-19 | 已定案（未逐項對照程式） |
| [導覽列、「更多」與建立選單](navigation-and-create.md) | 2026-10-25、10-29 | 已實作 |
| [側欄與指令面板共用同一套搜尋](shared-search.md) | 2026-10-29 | 已實作 |
| [快速捕捉是內建模組；未分類進收件匣；待審合進「等你決定」](quick-capture-inbox.md) | 2026-10-29、10-30 | 已實作 |
| [時間軸只放任務與專注；外部行事曆唯讀 iCal 是例外](timeline-tasks-focus.md) | 2026-10-31 | 已實作 |
| [每個空間一篇任務筆記；日記與 RSS 維持個人](task-note-per-space.md) | 2026-10-31 | 已實作 |
| [技能是功能，不是 #技能 標籤](skills-are-features.md) | 2026-10-31 | 已實作 |
| [簡報是筆記的一種檢視](slides-as-view.md) | 2026-10-31 | 已定案（未逐項對照程式） |
| [自動配色：兩個種子色產生全部 app 顏色](auto-colour.md) | 2026-10-30 | 已實作 |
| [內文合併是以行為單位的三方合併](body-three-way-merge.md) | 2026-10-17 | 已實作 |
| [允許清單嚴格模式；規則全部保留](allowlist-strict.md) | 2026-11-01 | 實作中 |
| [不做點對點同步；支援「伺服器常常不在」；拿掉 Apache AGE](no-p2p-intermittent-server.md) | 2026-11-01 | 已實作 |

## 另有的決定類文件（留在原位，AGENTS.md 與程式註解依賴這些路徑）

| 文件 | 內容 |
| --- | --- |
| [AI 協作的決定](../agents/decisions-ai-collaboration.md) | 待審建議、write_mode、API／MCP 跑法 |
| [模組分類的決定](../agents/decisions-modules.md) | 功能／內建模組／核心 |
| [復原與歷史](../agents/decisions-restore-history.md)、[核心寫入與同步](../agents/decisions-core-sync.md)、[離線與帳號](../agents/decisions-offline-account.md)、[匯入與本機備份](../agents/decisions-import-storage.md) | 工程邊界決定（第 1–25 批） |
| [白板](../agents/decisions-canvas.md)、[介面](../agents/decisions-ui.md) | 白板與介面的邊界決定（第 22–40 批） |
| [互動設計決定](../interaction-design/00-decisions.md) | 介面與導覽層的已定案決定 |
