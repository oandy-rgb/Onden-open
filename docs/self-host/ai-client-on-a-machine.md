# 讓 AI 在一台機器上自動領工作（MCP 角色）

「加入 AI 角色」有兩種方式：**API**（Onden 用你的金鑰呼叫 AI）與 **MCP**（你自己的 AI 用戶端連進來）。
MCP 角色有兩種用法，角色設定完全一樣：

- **手動**：你在自己的電腦上開一個支援 MCP 的 AI 用戶端，貼上角色的 MCP 金鑰，想用的時候叫它做事。
- **自動**：在一台電腦上（你的筆電、家裡的伺服器、VPS 都可以）執行 Onden 附的**回答程式** `onden-ai-answerer`。
  你在筆記裡 `@` 這個角色時，請求會先排隊；程式發現後，交給這台電腦上**已經登入**的命令列 AI 工具，答案寫回筆記。
  用的是你自己的 AI 訂閱，不需要 API 金鑰。

不論哪一種，Onden 都不會替 AI 打電話，只會等它來。排隊中的請求會一直等到用戶端來領（或到期）；
角色卡片上的「上次來」是用戶端最近一次來問有沒有工作、或呼叫 MCP 工具的時間。

## 你需要

1. 一個 MCP 角色（設定 › 空間與成員 › 加入 AI 角色 › MCP），並替它加入要工作的空間。
2. 角色的連線碼（建立時只顯示一次；弄丟了就在角色卡片另外發一把）。權限只到角色所在的空間。
   存成一個只有你讀得到的檔案：`install -m 600 /dev/null ~/.config/onden/ai.key`，再把連線碼貼進去。
3. 一個命令列 AI 工具，已安裝並**已登入**（目前內建支援哪些，見 [`packages/ai-answerer/README.md`](../../packages/ai-answerer/README.md)）。怎麼登入、用哪個帳號與模型，都由你自己決定。
4. Node.js 20 以上，與這個 repository 的檔案（`packages/ai-answerer/`，不需要 `npm install`）。

## 執行

```bash
# 前景執行（Ctrl+C 結束）
node packages/ai-answerer/bin/onden-ai-answerer.mjs run --server https://你的網址 --key-file ~/.config/onden/ai.key

# Linux：裝成使用者層級的背景服務（systemd，記憶體上限 768 MB，掛了會自動重啟）
node packages/ai-answerer/bin/onden-ai-answerer.mjs install --server https://你的網址 --key-file ~/.config/onden/ai.key
node packages/ai-answerer/bin/onden-ai-answerer.mjs status
node packages/ai-answerer/bin/onden-ai-answerer.mjs uninstall
```

網址與連線碼檔案也可以用環境變數 `ONDEN_SERVER_URL`、`ONDEN_AI_KEY_FILE`；AI 工具不在 PATH 時用 `--tool-command`（`ONDEN_AI_TOOL_COMMAND`）。
網址必須是 `https://`；只有這台電腦或內網位址可以用 `http://`。找不到 AI 工具或它還沒登入時，程式會用白話說明並結束，不會空等。
`install` 會把安裝當下找到的 AI 工具的**絕對路徑**寫進服務單元（背景服務拿不到你終端機的 PATH）。
macOS 與 Windows 目前只有前景執行；`install`／`status`／`uninstall` 會明說「還沒做」。

### 它怎麼運作、為什麼安全

一次只處理一個問題：領取 → 回報開始 → 用 AI 工具跑一次 → 交回答案（或失敗）。被取消的問題會停止 AI 工具；超過期限也會停止。
**筆記的文字可能含有「指令」**，所以 AI 工具是被關起來執行的，這是程式保證的，有守門測試鎖住：

- 沒有內建工具：不能讀寫這台電腦的檔案、不能執行指令、不能上網。
- 不讀你的個人設定、hook、記憶與專案檔案；在一個全新的空資料夾裡執行，結束就刪。
  這一條在 2026-11-16 用真的工具（2.1.311 版）驗過的範圍：個人設定裡的 hook 沒有執行、工作資料夾設定裡的 hook 沒有執行、放在工作資料夾的記憶檔沒有被讀、工具回報自己沒有任何可呼叫的工具。**沒有驗的**：放在家目錄的個人記憶檔（驗證的那台電腦沒有這個檔）。工具換大版本後要再驗一次。
- 唯一的工具是 Onden 的 MCP 工具，用領取時發的**這件事專用金鑰**（寫在 0600 的暫存檔，不在命令列或環境變數，這件事結束就失效）。

領了的問題一定會有結果：答案太長或被伺服器拒絕時回報失敗、程式被停止時回報失敗（不會卡到期限）。
背景服務的記憶體上限（768 MB）連 AI 工具一起算。2026-11-16 在一台筆電上量過：AI 工具單獨回答一句話、沒有呼叫筆記工具時，最高約 225 MB；長回答與多次工具呼叫時的用量沒有量過。
連線碼只從檔案讀取：不會出現在命令列、記錄或其他檔案，權限比 600 寬的檔案會被拒絕。
AI 工具輸出的過程不轉成進度（只回報「開始」）；Onden 目前不顯示 AI 工具內部的思考與步驟。

## 領工作的協定

回答程式與自己寫的腳本都用這幾個 HTTP 呼叫。`pending`、`claim` 用角色的連線碼當 `Authorization: Bearer`，`events`、`finish` 與狀態查詢用 `claim` 發的 session 金鑰：

| 呼叫 | 作用 |
| --- | --- |
| `GET /api/mcp/sessions/pending?wait=25` | 長輪詢：有排隊的請求就立刻回，沒有就最多等 25 秒。回 `{ "sessions": [{ "id": … }] }` |
| `POST /api/mcp/sessions/{id}/claim` | 領走一件（同時只有一個用戶端領得到）。回請求內容與一把只在這件事有效的 **session 金鑰** |
| `POST /api/mcp/sessions/{id}/events`（選用） | 回報進度 |
| `POST /api/mcp/sessions/{id}/finish` | 交回結果：`{"status":"completed","result_markdown":"…"}` 或 `{"status":"failed"}` |

`claim` 回傳的 `rendered` 是已經組好的提示（`system` 加 `messages`），`mcp.token` 是這一件事專用的 MCP 金鑰：
讓 AI 工具用它連到 `claim` 回傳的 `mcp.path`（`https://你的網址/api/mcp/protocol`），AI 就只能讀寫這則筆記所在的空間，且在這件事結束後失效。

## 附錄：不用這支程式、自己寫腳本

只要會下面的 HTTP 呼叫，任何語言都能做同一件事。把 AI 工具接進來時要做到上面「為什麼安全」的三點，否則筆記裡的文字就能操作那台電腦。
連線碼放在只有腳本讀得到的地方；金鑰不要放進命令列。輪詢與重試的規則：沒事時用 `wait=25` 長輪詢，被拒絕（401／403）等一分鐘，
斷線等 15 秒，不要緊密重試；結果交不出去時重試 3 次。

## 注意

- 領走之後要在期限內交回（`claim` 回傳的 `session.deadline_at`）；逾時的請求會被標成失敗，再由人重送。
  session 金鑰在期限時一起失效，所以回答程式在期限前約 5 秒就停止 AI 工具，好讓它還來得及回報失敗（上限 10 分鐘）。
- 同一個角色同時最多跑幾件有上限，超過時 `claim` 回 429，稍後再試。
- 請求被取消時，`GET /api/mcp/sessions/{id}`（用 session 金鑰）會顯示已取消，長時間的工作可以偶爾看一眼。
- 角色連線碼等於這個角色的身分：放在只有回答程式讀得到的地方；懷疑外洩就到角色卡片撤銷並重發。
- 用 MCP 金鑰連進來的 AI 是否能直接改筆記，看角色的「審核規則」（先給我看／直接修改，可復原）。
