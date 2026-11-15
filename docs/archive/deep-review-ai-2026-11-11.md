# 深入審查：AI 協作（agent、MCP、建議、金鑰）— 2026-11-11

> 狀態：歷史紀錄（全部處理完；修正見 #1498，最後確認 2026-11-12）

審查報告（只看程式；產品程式沒有改）。範圍與方法來自審查任務說明；分支 `review/deep-ai-2026-11-11`。

## 結論

這一塊的主幹是穩的：我用「列舉所有工具」、「隨機操作序列」、「整個資料庫與備份搜尋金鑰」三種新做法去打，
都沒有找到越權、金鑰外洩或丟資料。找到的是 4 個較小的問題（1 個資訊外洩、2 個「誰能決定」的缺口、1 個花費上限的縫），
都已用 `it.fails` 釘住；沒有可重現的高嚴重度問題。

## 問題一覽

| 編號 | 一句話說明 | 嚴重度 | 狀態 | 測試檔 |
| --- | --- | --- | --- | --- |
| AI-1 | AI 失去某則筆記的讀取權後，`listMySessions`／`getSessionLog` 仍回傳當初從那則筆記複製出來的提問文字（`prompt`，最多 200 字） | 中（低量資訊外洩，需先有過一次工作階段） | 已修（PR #1488） | `aiToolScopeSweep.integration.test.ts` |
| AI-2 | 筆記被搬到別的空間後，只有「唯讀」權限的人也能接受／拒絕建議，結果是把待審的處永久標成「失效（void）」 | 低～中 | 已修（PR #1488） | `aiCollabEdges.integration.test.ts` |
| AI-4 | API 工作階段超過期限（`deadline_at`）後，在清掃工作跑到之前仍會繼續付費呼叫模型（最多 12 輪） | 低（花費；有輪數上限） | 已修（PR #1488） | `aiCollabEdges.integration.test.ts` |
| AI-5 | 「某 AI 的主人」＝發過它常駐 token 的人，只看有沒有被撤銷，不看有沒有過期；過期 token 的發行者仍能指揮該 AI | 低 | 已修（PR #1488） | `aiCollabEdges.integration.test.ts` |
| AI-3 | 並行多個 API 工作階段可同時越過每月 token 上限 | 低 | 未重現（只讀程式，沒寫測試；見下） | — |

新型測試（沒找到問題的也留下，當安全網）：

| 測試 | 做什麼 | 結果 |
| --- | --- | --- |
| `aiToolScopeSweep.integration.test.ts` | 走訪登錄表中**每一個**工具（新工具沒有案例就失敗），用「完全不在的空間 B」與「只能看的空間 C」的筆記去呼叫，比對資料庫前後：筆記、標籤、屬性、建議、事件、筆記總數都不變；另外 API 工作階段能用的工具打在自己空間時，只能多出建議事件，outbox 不增加 | 通過（AI-1 另列） |
| `properties/aiSuggestionAccept.property.integration.test.ts` | 隨機生成「AI 提議（改／刪／插）」與「接受前人的編輯（改／刪／插）」的組合，接受後檢查：人寫的字不丟、沒有半套套用、沒有留下 pending、不碰人改過或相鄰的處以外的地方一定套用、重複接受無作用 | 通過（3 個種子 × 80 次） |
| `aiKeyLeak.integration.test.ts` | 加入金鑰、跑成功／用工具／供應商回錯誤訊息（內含金鑰）／中途撤銷四種工作階段後，在**資料庫每個表的每一列**、stdout／stderr、擁有者的金鑰清單、完整備份 zip 的每個檔案裡搜尋金鑰明文與密文 | 通過（找不到） |
| `aiCollabEdges.integration.test.ts` 中的「失敗的修訂」 | 注入第 N 次寫入失敗（建議項目的 INSERT 丟例外）：AI 自我修訂時先把舊的標成 `replaced` 再寫新的，失敗時舊的必須還是 pending、不留事件；故障排除後重送可成功 | 通過 |

## 細節

### AI-1　失去權限後，AI 的「記憶」工具仍給出筆記裡的字

- 觸發：AI 在空間 S 的某則筆記被 @ 提及，產生工作階段（`prompt` ＝ 提及那段的文字，最多 4,000 字，存在 `agent_sessions.prompt`）。之後 AI 被移出 S（或筆記被搬走）。AI 呼叫 `listMySessions`／`getSessionLog`。
- 後果：筆記標題被遮成「無法存取的筆記」，但 `prompt` 前 200 字照給。提及那段文字常含使用者貼的內容。工具說明寫「never note text」，與行為不符。同一份資料也進 `renderPreviousRuns`（只限同一則筆記，且那時 AI 已讀不到該筆記，prompt 仍進提示詞）。
- 位置：`services/agentSessionMemory.ts` `ownSessions`／`ownSession`（`LEFT JOIN … AND ${scope}` 已經知道可不可讀，`n.title IS NULL`＝讀不到，但 `s.prompt` 無條件選出）；`services/agentTools/sessionMemory.ts` `summary`。
- 建議修法：讀不到的筆記，`prompt` 回空字串（或固定的「無法存取」）。約 10 行，加一個「失去空間後」的測試（`it.fails` 轉成一般測試）。我沒有在這次修，因為它改了 `renderPreviousRuns` 的輸出，屬於需要業主確認行為的小改動，不只是「補上既有檢查」。
- 測試：`aiToolScopeSweep.integration.test.ts` →「a session on a note the agent can no longer read does not hand back the words copied from that note」（`it.fails`）。信心：高（已在資料庫上重現）。

### AI-2　唯讀的人能讓待審建議永久失效

- 觸發：AI 對空間 A 的筆記提了建議；筆記被搬到空間 D，D 裡某人只有「檢視」。這個人對該建議按拒絕（或接受）。
- 後果：`acceptSuggestionItems`／`rejectSuggestionItems` 先走「筆記搬走了（`placeGone`）」分支，把所有待審的處標成 `void` 並提交，這一步**沒有檢查寫入權**；後面的 `assertAuthority(write_node)` 只在沒搬走時才跑。`void` 是最終狀態，筆記搬回原空間後建議也回不來。原本的設計是「沒有寫入權的人不能決定任何一處」（見檔頭註解與既有測試「uses the person's rights at the moment of accepting」）。
- 位置：`services/aiSuggestions.ts` `acceptSuggestionItems`（`placeGone` 在 `assertAuthority` 之前）與 `rejectSuggestionItems`（`placeGone` 之前沒有任何授權檢查，授權在 `mutate` 裡）。
- 建議修法：兩處都在 `placeGone` 之前先 `assertAuthority(actor, { kind: "node", nodeId, op: "write_node" })`。各 1 行；既有測試用擁有者，不受影響。
- 測試：`aiCollabEdges.integration.test.ts`（`it.fails`）。信心：高。

### AI-4　超過期限仍會繼續付費呼叫

- 觸發：API 工作階段執行中，`deadline_at`（`timeout_seconds`）已過，但定期清掃（`expireOverdue`）還沒跑。
- 後果：每一輪之間的檢查 `assertMayContinue` 只看狀態、角色、金鑰、月上限，不看期限。工具呼叫會因 token 同時到期而失敗，但模型仍被呼叫（每輪都花錢），最多到 `MAX_TURNS`＝12。實際損失是有上限的少量花費，但「時間上限」這個承諾只靠清掃的時機。
- 位置：`services/agentRuntime/api/run.ts` `assertMayContinue`。
- 建議修法：載入 session 後若 `deadline_at <= now()` 就 `throw new Stop("timeout")`（沿用清掃寫入的失敗代碼）。1 行。
- 測試：`aiCollabEdges.integration.test.ts`（`it.fails`，第一次呼叫後把期限改到過去，預期不再有第二次付費呼叫，實際有 2 次）。信心：高。

### AI-5　過期的常駐 token 仍讓發行者成為 AI 的主人

- 觸發：某人（非擁有者）曾被發過某 AI 的常駐 token（擁有者簽發，帶 `expires_at`），token 過期但沒被撤銷。
- 後果：`mayDirect` 以 `issued_by = 此人 AND session_id IS NULL AND revoked_at IS NULL` 判斷，沒看 `expires_at`；此人仍可 @ 該 AI。對 API 角色這意味著繼續花擁有者的金鑰（金鑰是角色層級的，不是發起人的）。擁有者要發 token 才會發生，且其他閘（`agent_rate_limited`、月上限）仍在，所以只算低。
- 位置：`services/agentSessions.ts` `mayDirect`。
- 建議修法：加 `AND (expires_at IS NULL OR expires_at > now())`。1 行。
- 測試：`aiCollabEdges.integration.test.ts`（`it.fails`）。信心：高。

### AI-3　月上限在並行下可被越過（未重現）

- 讀程式的推論：月上限靠 `monthTokensUsed`（已記錄的用量）在開始與每輪之間檢查；用量在每次模型回應後才記，所以同時開 N 個工作階段（`max_concurrent` 預設 2、`max_per_hour` 預設 30）會各自在上限邊緣再多付一輪（最多約 N × 16,000 輸出 token）。這是有界的超出，且擁有者可選「不設上限」。我沒有為它寫測試：要靠時序，且屬於設計取捨。列入「未重現」。

## 查過沒問題的

- **token 範圍**：每個已註冊工具（含 semantic 模組的兩個）對「不在的空間」與「只能看的空間」都被擋住，out-of-scope 的 `getNode`／`getAttachment`／`queryView`／`searchNodes`／`semanticSearch`／`suggestLinks` 讀不到文字；寫入工具（`updateNode`、`createNode`、`applyTag`、`removeTag`、`suggestEdit`、`commentOnNote`）在兩種寫入模式下都沒有改到範圍外的筆記、標籤、屬性、建議或事件。（`reviewQueue` 在測試裡只能對沒有登記卡片的筆記打，所以這一項較弱，既有的 `readScopeAgent`／`taskScopeContract` 等測試補它。）
- **只能提建議**：API 工作階段可用的全部工具，打在自己空間時，只多出 `AI_SUGGESTION_CREATED` 與稽核事件；`proposeTagPack` 因為不是 `mutate` 事件，被 `NOT_FOR_API` 排除，outbox 數量不變。
- **建議被接受時筆記已被改過**：隨機測試證明人的字不會丟、人改過的處失效而不是被蓋掉；同一建議多裝置／重送只套一次（既有測試也涵蓋）。
- **金鑰**：明文不在任何資料表、紀錄輸出、金鑰清單、備份 zip；密文只在 `ai_credentials`，備份 zip 不含（`backupExtras.ts` 檔頭也明說）。供應商回傳的錯誤文字（含金鑰）不進工作階段紀錄。`ONDEN_SECRET_KEY` 遺失：`secret_key_missing`／`credential_unreadable` 409，不會用空金鑰呼叫（既有測試涵蓋）。
- **筆記內的指令（prompt injection）**：沒有任何工具的權限取決於提示詞；AI 能做到的上限＝它的 token 範圍 × 工具清單，API 路徑再被限制為只能提建議（上面的走訪測試是證據）。MCP 的「直接改」agent 在自己可寫的空間內仍可被筆記裡的指令誘導去改別則筆記——這是 `write_mode = apply` 的設計，不是漏洞，但擁有者應知道（建議保留「先給我看」為預設，現況已是）。
- **@提及的身分與金鑰**：只有人類（無 token）能發起；發起者須有筆記寫入權，並且是擁有者或該 AI 的主人（AI-5 為例外）；API 路徑用角色上設定的金鑰（擁有者的），不是發起者的。
- **工作階段上限**：`max_per_hour`、`max_concurrent`、`MAX_TURNS`、`deadline_at`（認領時與 token 到期）、被取消後下一輪前停止（有測試）、金鑰被撤銷後下一輪前停止（既有測試）。紀錄的筆記內容：`reply_markdown`／訊息紀錄只有發起者或擁有者且**目前讀得到筆記**的人看得到（`sessionView`）。
- **等待期間對象被丟垃圾桶／搬走**：垃圾桶：建議隱藏、還原後可接受；搬走：失效（AI-2 為授權缺口）。
- **注入失敗**：建議的修訂、接受時存檔失敗都整體回滾（見新型測試與既有測試）。

## 這次沒查到的範圍

- 前端（`modules/ai/`、`InboxReview.tsx`、`useAgentMentions.ts`）只讀了 `useAgentMentions` 的結構（送出走線上寫入路徑、以冪等鍵重送；沒有看到會在失敗時清空輸入的路徑），沒有跑前端測試或做瀏覽器檢查。
- `agentRuntime/api/protocols/` 各供應商格式（串流中斷、半截回應）與 SSRF（擁有者新增金鑰時輸入的服務位址可指向內網，偵測請求會帶著金鑰；這是擁有者自己的設定，沒有列為問題）。
- `reviewQueue`、`loadSkill`（技能權限）的範圍測試較淺；MCP 路由層（`routes/mcpProtocol.ts`、`mcpSessions.ts`）的認證與 session 管理只經由工具層間接覆蓋。
- 「接受後復原」：只讀文件與既有的 `revertSession` 測試，沒有另寫隨機序列（接受後以歷史復原，項目狀態保持 `accepted`，建議不會回到待審——設計文件明說如此）。
- 需在真 Postgres 補跑：這批新測試全部在 PGlite 上跑過；`aiCollabEdges` 的注入失敗用了資料庫 trigger，在真 Postgres 行為應相同，但未驗證。
