# 交給 AI 代理：終端機、寫程式、看檔案

> 狀態：現行
> 涵蓋：packages/backend/src/services/agentTools/**, packages/backend/src/services/agentRuntime/**, packages/backend/src/spine/toolScope.ts

方向文件，不是排程中的工作：做法 1（外接代理）與 API 跑法已是現況，做法 2（長時間代理任務）尚未做，實作前再和使用者確認。
和 [harness](harness.md)（技能與 MCP prompts；模型呼叫只在 API 跑法）、[模組庫](module-library.md)（不跑第三方程式）、[AI 協作決定](../agents/decisions-ai-collaboration.md)（待審建議、跑法）一起讀。

## 一句話

Onden 不做終端機、程式開發環境、檔案總管，也不在伺服器上跑任何第三方程式；這些事交給 **AI 代理在 Onden 外面做**。Onden 只負責兩件事：**交代**（用筆記寫指示、用權限決定能碰什麼）和**收結果**（結果經過權限檢查與使用者確認才寫回）。

Onden 的 AI 只有兩條路，共用同一組工具、權限、寫入與紀錄（根目錄 `AGENTS.md`）：**MCP**（使用者自己的 AI 用戶端用限權 token 連進來；終端機與檔案都在用戶端那一邊）、**API 跑法**（伺服器用使用者自己的 API 金鑰呼叫模型，只能提建議，見 [AI 協作決定](../agents/decisions-ai-collaboration.md)）。API 跑法只用 registry 的工具，沒有終端機、程式碼執行或檔案存取；需要這些時走 MCP，在使用者自己的環境做。

## 為什麼

### Onden 不跑第三方程式

這是 [模組庫](module-library.md) 的決定：缺什麼就加官方模組，不讓使用者把程式塞進系統。原因：

- **安全**：Onden 跑在伺服器上、可能多人使用。前端插件跑在頁面裡就能讀到登入狀態和已載入的筆記；後端插件等於直接碰資料庫。Obsidian 的插件沒有沙盒，在單人本機尚可接受，在 Onden 不行。
- **穩定**：開放插件就要承諾介面不輕易變動；每次內部整理（例如 A1–A3）都可能弄壞別人的插件。
- **一致**：每個人的 Onden 都一樣，好用、好教；不會出現「插件互相打架」。

要安全地開放第三方程式，得做前端隔離（iframe／Web Worker 加受控介面）、後端沙盒（獨立程序或 WebAssembly 加能力介面）、插件權限、穩定的版本化介面、審核機制。這是一整個平台工程，現階段不做。


### AI 代理就是「跑在外面的插件」

- 它有自己的執行環境：能開終端機、寫程式、讀檔案、上網。
- 它透過 MCP 讀寫 Onden，權限被 token 限住：token 是唯讀（`read`）或可寫（`write`），能碰哪些空間跟著它的 agent 的空間成員資格（再受空間的「外部 AI」開關限制，見 [空間](spaces.md)）。
- 它出事最多影響它自己的環境，以及 token 允許碰的筆記；碰不到 Onden 的資料庫或伺服器。

所以「把能力外包給代理」等於拿到 Emacs 式的「什麼都能做」，但所有執行都發生在安全邊界外。

## 兩種做法（由近到遠）

### 1. 外接代理（現在就能用）

例如 命令列或桌面的 MCP 用戶端：本身有終端機和檔案存取，透過 Onden 的 MCP 接進來。

- 使用者在 Onden 寫技能筆記：「讀這個專案的程式碼，產生架構說明，存成筆記」。
- 代理從 MCP 的 prompts 拿到技能（[harness](harness.md)），在使用者自己的電腦上讀程式碼、跑指令，結果用 MCP 的 createNode／updateNode 寫回。
- Onden 這邊看到的是「某個 token 新增了一則筆記」。**結果怎麼生效看該角色的審核規則**（`actors.write_mode`，見 [AI 協作決定](../agents/decisions-ai-collaboration.md)）：
  新建立的角色預設 `suggest`，`updateNode` 變成待審建議、`createNode`／`applyTag`／`removeTag` 被拒絕（改用 `commentOnNote`）；既有角色維持 `apply`，寫入立即生效，收件匣事後列出供檢視，拒絕時會撤銷這次寫入。
  只有「暫緩的副作用」（outbox 的 `pending_approval`，目前只有 `proposeTagPack` 的 `tag_pack`）是先核准才執行。代理沒有「發布網站」的工具：發布只有擁有者自己按「發布到網站」（`POST /api/publish`）；將來要讓 AI 發布會重新設計（2026-10-31 業主決定，不留相容層）。
- 自動領工作：[ai-client-on-a-machine.md](../self-host/ai-client-on-a-machine.md)（放在某台機器上的 MCP 用戶端輪詢排隊中的工作並領取）。

#### 代理可用的工具與讀附件

工具以 `services/agentTools/registry.ts` 的 registry 為準（模組的工具由模組登記）。讀取類：`searchNodes`、`getNode`、`getAttachment`、`queryView`、`listChildren`、`listSpaces`、`listSuggestions`（建議每一處的結果）、`loadSkill`、`listMySessions`／`getSessionLog`（自己過去的工作階段）、`getSlides`（簡報模組）、`semanticSearch`／`suggestLinks`（語意模組）；寫入類：`updateNode`、`createNode`、`applyTag`、`removeTag`、`suggestEdit`、`commentOnNote`、`setSlideLayout`、`proposeTagPack`。
`read` 等級的 token 含所有讀取工具，包括 `getAttachment`；已發出的 token 帶的是當時展開的清單，不會自動增加，要讀附件須重發或編輯 token 的工具清單。

`getAttachment({ nodeId, ref })` 讓代理看到筆記裡貼的圖（例如手機截圖的錯誤回報）。`getNode` 回傳的 `attachments` 列出正文引用的檔案（`ref`、種類、MIME、大小）。PDF 筆記另有一句 `pdf_note`：內文有幾個字元的抽出文字，或抽不出文字（掃描檔）；代理沒有取得 PDF 檔本身的方式。規則：

- 代理須能讀該筆記（和 `getNode` 同一套空間／token 範圍；讀不到回 `null`，與不存在無法區分）。
- 檔案須被**這則筆記的正文**引用（`/api/media/<id>`、`![[<id>]]` 或裸 id），且媒體擁有者規則（`canReadMedia`）也允許；不能憑媒體 id 任意取檔，也不能把別處私有圖的網址貼進可讀筆記來取得。
- 圖片經 MCP 回 `image` 內容區塊（加一段文字說明），REST 回 `data_base64`；非圖片只回中繼資料。超過 5 MB 的圖片縮到長邊 1600px 的 WebP，仍過大或無法解碼回 `error: "too_large"`。
- 不增加 token 在 `/api/mcp/*` 以外的權限；呼叫與其他工具一樣寫入 `AGENT_TOOL_CALLED`／`AGENT_TOOL_FAILED`。

### 2. 長時間的代理任務（更遠，尚未做）

「每週整理一次收件匣」「把整個資料夾的 PDF 讀完做成筆記」這種要跑很久、可能要排程的工作，交給代管的代理服務（例如 服務商提供的代管代理：自己的容器、可排程、可長時間執行）。


- Onden 發出任務（指示＋權限受限的 token），代理在外面跑，結果透過 MCP 寫回。
- 接到 Onden 的**副作用系統**（outbox）：寫入完成後可靠地觸發後續動作、失敗會重試、有紀錄；現有的 `pages_push`、`rss_fetch` 都是這樣註冊的。新增一種副作用 `agent_task`，觸發方式可以是：
  - 筆記貼上某個標籤（例如 `{代理任務}`）；
  - 使用者按「交給代理」；
  - 排程。
- 任務狀態（排隊、執行中、完成、失敗）和花費寫回那則筆記，看得到、可以取消。


## 要守住的規則

1. **終端機和程式碼絕不在 Onden 伺服器上執行**，只在代理自己的環境。
2. **代理的權限只透過 token 給**：唯讀或可寫，空間範圍跟著 agent 的空間成員資格；預設最小。不給一般 REST 存取（現有邊界：bearer token 只能用 `/api/mcp/*`）。
3. **寫回要能檢視、能復原**：代理的寫入走正常的權限檢查與事件紀錄；角色的審核規則（`suggest`／`apply`）決定是先給人審、還是立即生效後事後檢視（拒絕即撤銷）。需要「先核准才生效」的動作，要做成暫緩的提案（像 `proposeTagPack` 那樣）。
4. **送出的資料受「外部 AI」開關限制**：開關關著的空間，筆記不會送給代理。
5. **沒有預設模型、Onden 不選模型**：MCP 的代理用哪個模型由使用者在自己的 AI 選，Onden 沒有設定；API 跑法的服務、金鑰與模型由擁有者自己在設定 › AI 填，金鑰只存在伺服器、加密保存，模型沒有預設。
6. **花費看得到、有上限**：API 跑法每個 session 最多 12 回合、每月 token 上限（或擁有者明確選「不限」），用量記在 session；MCP 的花費在使用者自己的訂閱，Onden 看不到。長時間任務（做法 2）若做，要同樣記錄用量並設上限。
7. **技能是指令、筆記是資料**：只有使用者自己寫的技能筆記能當指令；讀進來的其他筆記一律當資料（和 harness 的規則一致）。

## 對照：Onden 的「可程式化」

Onden 沒有 Emacs Lisp，但有三條路讓使用者自訂行為，都不需要把程式放進系統：

| 方式 | 像 Emacs 的什麼 | 例子 |
|---|---|---|
| 用筆記定義行為 | 設定檔、小指令 | 技能筆記、查詢區塊、標籤的欄位與行為規則、範本 |
| 外部程式透過 MCP／API | 外部套件 | 命令列或桌面的 MCP 用戶端、自己寫的腳本（token 限權） |
| 官方模組 | 官方套件 | 複習、引用、網站、RSS、白板 |

這份文件說的「交給代理」，是第二條路的延伸：讓外面的程式不只讀寫筆記，還替使用者做終端機、程式、檔案這類事情，再把結果帶回 Onden。

## 建議的順序

1. **現在**：做法 1 已可行；怎麼開限權 token 見設定 › AI 的連線碼，自動領工作見 [ai-client-on-a-machine.md](../self-host/ai-client-on-a-machine.md)。
2. **更之後**：常有長時間工作時，再做 `agent_task` 副作用與任務狀態（做法 2；目前程式裡沒有 `agent_task`）。

## 參考

- [harness](harness.md)：技能與 MCP prompts（Onden 不呼叫模型）
- [模組庫](module-library.md)：官方模組、不跑第三方程式
- [空間](spaces.md)：token 的空間範圍與「外部 AI」開關

## 歷史

### 2026-10-14　最初的想法

2026-10-14，note-0f 依使用者的想法寫成：「終端機、寫程式、看檔案總管，也許這些能當副作用外包給 AI」。

### 2026-10-23　權限與唯一 AI 路徑（後來被 2026-10-30 部分推翻）

> **2026-10-23 更新（後端）**：規則 2 的「token ＝ 哪些空間 × 哪些工具」已改為「token ＝ 唯讀／可寫」；
> 空間範圍永遠等於 agent 自己的空間成員資格（再受空間的「AI 可讀取」開關限制），沒有 per-token 空間清單與簽發者夾住。

> **2026-10-23：MCP 是 Onden 唯一的 AI 路徑。** 內建的 API AI（伺服器拿 API key 呼叫模型）已整個移除，見 [harness](harness.md)。下面「三種做法」裡的第 2 種（內建 AI 用服務商的伺服器端工具）因此**作廢**，只留作歷史；第 1 種外接代理就是現在的做法，第 3 種長時間任務也會走外接代理（@ai 提及）。

### 2026-10-30　API 跑法加回來

> **2026-10-30 更新**：AI 角色多了「API 跑法」（伺服器用使用者自己的金鑰呼叫模型，只能提建議；工具、權限、寫入、紀錄與 MCP 同一份），
> 見 [決定紀錄](../agents/decisions-ai-collaboration.md)。MCP 跑法不變（原本的「訂閱」併進 MCP，見決定紀錄 2026-11-01）。

### 2026-10-23　原「三種做法」的第 2 種：內建 AI 用服務商的伺服器端工具（已作廢）

原本想在 harness 的 H5 工具迴圈裡接 服務商的伺服器端工具（程式碼執行、網頁抓取）。內建 API AI 已於 2026-10-23 移除，Onden 不再呼叫任何模型；
需要這類能力時，由使用者自己的 AI（做法 1）在它的環境裡做，結果經 MCP 寫回。
