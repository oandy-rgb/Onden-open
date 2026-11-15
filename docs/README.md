# Onden 文件目錄

> 狀態：現行（最後確認 2026-11-01）

結論：**現行文件**在 `docs/agents`、`docs/architecture`、`docs/decisions`、`docs/interaction-design`、`docs/self-host` 與少數頂層檔；
進行中的盤點在 `docs/research`；所有已完成、已被取代的紀錄在 `docs/archive`（不再維護，引用前先查程式）。
每份文件檔頭都有一行 `> 狀態：現行／已被取代（by …）／歷史紀錄（最後確認 日期）`。

## 新人先看這 5 份

| 想知道 | 看 |
| --- | --- |
| 架構地圖 | [architecture/overview.md](architecture/overview.md) |
| 怎麼跑 | 根目錄 [README.md](../README.md)（安裝與啟動）；自架見 [self-host/https.md](self-host/https.md) |
| 怎麼測 | [agents/testing.md](agents/testing.md) |
| 怎麼部署 | [agents/deploy.md](agents/deploy.md)（部署紀錄：deploy-log.md（未隨公開庫附上）） |
| 產品決定 | [decisions/README.md](decisions/README.md) |

規則總覽在根目錄 [AGENTS.md](../AGENTS.md)；要新增共用元件或函式前，先查[唯一入口清單](agents/entrypoints-catalog.md)。

## docs/agents：開發規則與邊界決定

| 文件 | 一句話 |
| --- | --- |
| [backend-rules.md](agents/backend-rules.md) | 後端寫入、權限、事件、交易、復原的完整規則 |
| [design-principles.md](agents/design-principles.md) | 設計新介面、切模組、命名與契約註解的準則 |
| [errors-and-saves.md](agents/errors-and-saves.md) | 前端保存、離線、錯誤處理的一致契約 |
| [testing.md](agents/testing.md) | 驗證範圍、測試寫法與完成條件 |
| [deploy.md](agents/deploy.md) | 部署、回滾、備份與還原演練 |
| [entrypoints.md](agents/entrypoints.md) | 某個責任在哪個檔案、架構與研究文件在哪 |
| [entrypoints-catalog.md](agents/entrypoints-catalog.md) | 依需求查「唯一入口」（由腳本產生，勿手改） |
| [references.md](agents/references.md) | 設計準則的論文與教材依據 |
| [decisions-restore-history.md](agents/decisions-restore-history.md) | 復原、屬性與標籤、歷史、版本的邊界決定（第 1–5 批） |
| [decisions-import-storage.md](agents/decisions-import-storage.md) | 本機備份與匯入的邊界決定（第 6–9 批） |
| [decisions-core-sync.md](agents/decisions-core-sync.md) | 核心寫入、冪等、同步、membership（第 10–17 批） |
| [decisions-offline-account.md](agents/decisions-offline-account.md) | 離線佇列、登入、帳號隔離、啟動（第 16–25 批） |
| [decisions-canvas.md](agents/decisions-canvas.md) | 白板與手寫的邊界決定（第 22、26–38 批） |
| [decisions-ui.md](agents/decisions-ui.md) | 側欄、指令面板、匯出、選位置的邊界決定 |
| [decisions-modules.md](agents/decisions-modules.md) | 模組分三種：功能／內建模組／核心 |
| [decisions-ai-collaboration.md](agents/decisions-ai-collaboration.md) | AI 的修改先是待審建議；API／MCP 跑法 |

## docs/architecture：設計與契約

| 文件 | 一句話 |
| --- | --- |
| [overview.md](architecture/overview.md) | 架構總覽：寫入閘門、事件、同步、合併、模組、守門 |
| [feature-map.md](architecture/feature-map.md) | 功能解構地圖與建議邊界 |
| [sync-protocol.md](architecture/sync-protocol.md) | 離線優先、事件為本的同步協定 |
| [membership-and-permission-epoch.md](architecture/membership-and-permission-epoch.md) | 可讀集合核對與權限世代 |
| [spaces.md](architecture/spaces.md) | 空間：用「放在哪裡」決定誰看得到 |
| [restore-writes.md](architecture/restore-writes.md) | 復原的審核與寫入契約 |
| [history-api.md](architecture/history-api.md) | 整個工作區的歷史 API 與畫面 |
| [domain-writes.md](architecture/domain-writes.md) | 任務、屬性、標籤、關聯、白板的領域寫入 |
| [note-writes.md](architecture/note-writes.md) | 筆記寫入模組 `noteWriter` |
| [website-writes.md](architecture/website-writes.md) | 網站、工作區與筆記歷史的寫入邊界 |
| [patch-writes.md](architecture/patch-writes.md) | 只送差異的寫入與三方合併基準 |
| [note-duplicates.md](architecture/note-duplicates.md) | 筆記安全副本 API |
| [block-nodes.md](architecture/block-nodes.md) | 段落節點（可升級成子筆記） |
| [excerpts.md](architecture/excerpts.md) | 摘錄：帶來源的段落（RSS 劃線已做） |
| [canvas-as-view.md](architecture/canvas-as-view.md) | 白板是筆記的視角 |
| [views-as-modules.md](architecture/views-as-modules.md) | 月曆、看板、卡片是標籤的功能 |
| [module-library.md](architecture/module-library.md) | 模組庫：內建能力像函式庫一樣引入 |
| [module-extension-points.md](architecture/module-extension-points.md) | 模組擴充點 1–4 的實作結果 |
| [tasks-module.md](architecture/tasks-module.md) | 任務模組 |
| [task-links.md](architecture/task-links.md) | 筆記連到任務、嵌入可勾任務列 |
| [day-timeline.md](architecture/day-timeline.md) | 日子時間線的資料與任務 |
| [skills-and-presentation.md](architecture/skills-and-presentation.md) | 技能與簡報模式 |
| [presentation.md](architecture/presentation.md) | 簡報的切頁與播放 |
| [site-render-model.md](architecture/site-render-model.md) | 發布網站的呈現模型 |
| [harness.md](architecture/harness.md) | 技能 harness：技能只組 prompt，模型呼叫只在 API 跑法 |
| [agent-delegation.md](architecture/agent-delegation.md) | 把終端機、寫程式、看檔案交給 AI 代理 |
| [proposals/block-anchors-2026-11-01.md](architecture/proposals/block-anchors-2026-11-01.md) | 段落錨點：正文不放記號，錨點存在新表（提案；取代「段落記號自成一行」） |
| [proposals/ai-collaboration-2026-10-27.md](architecture/proposals/ai-collaboration-2026-10-27.md) | AI 協作提案（批 0–2 已動工） |
| [proposals/publish-redesign-2026-10-24.md](architecture/proposals/publish-redesign-2026-10-24.md) | 發布改版：內容來自筆記，Puck 只管排版（實作中） |
| [proposals/roles-owner-member-2026-10-22.md](architecture/proposals/roles-owner-member-2026-10-22.md) | 只剩擁有者／成員（後端已實作） |

## docs/decisions：產品決定

見 [decisions/README.md](decisions/README.md)（25 個決定，每個一檔，含實作狀態）。

## docs/interaction-design：介面與導覽

| 文件 | 一句話 |
| --- | --- |
| [README.md](interaction-design/README.md) | 「一個家、多種視角」的介面設計總說明 |
| [00-decisions.md](interaction-design/00-decisions.md) | 已定案的介面決定層 |

01–10 的跨產品研究已移到 [archive/interaction-design/](archive/interaction-design/)。

## docs/self-host：自架

| 文件 | 一句話 |
| --- | --- |
| [https.md](self-host/https.md) | 自架的三條 HTTPS 路與真實 IP 設定 |
| [recovery.md](self-host/recovery.md) | 忘記密碼、撤銷登入狀態的管理指令 |

## 其他頂層檔

| 文件 | 一句話 |
| --- | --- |
| [performance-budgets.md](performance-budgets.md) | 20k 篇筆記的效能預算與基準測試 |
| deploy-log.md（未隨公開庫附上） | 每次部署一列的紀錄（不整理） |

## docs/research：進行中

| 文件 | 一句話 |
| --- | --- |
| [full-feature-audit.md](research/full-feature-audit.md) | 全功能盤點與驗收清單（持續更新） |
| [board-seams-2026-10-31.md](research/board-seams-2026-10-31.md) | 白板兩層之間的接縫，待擁有者決定 |
| [pdf-unify/step2-design.md](research/pdf-unify/step2-design.md) | PDF 與手寫頁合一第 2 步 |
| [local-db-opfs-plan-2026-10-19.md](research/local-db-opfs-plan-2026-10-19.md) | 本機資料庫 OPFS 計畫（未做） |
| [dup-sweep-2026-10-29-*](research/) | 逐字／近似重複清單（後端、前端、跨套件），守門測試引用 |
| [dup-patterns-2026-10-30-*](research/) | 「各寫各的」概念重複清單（後端、跨套件、前端三份、內容顯示），守門測試引用 |

## docs/archive：歷史與已被取代

見 [archive/README.md](archive/README.md)。包含 2026-09～10 的審核、實測、修復紀錄、舊研究報告
（`archive/research/`）、已被取代的設計（`archive/architecture/`）與跨產品介面研究（`archive/interaction-design/`）。
