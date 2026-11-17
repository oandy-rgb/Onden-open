# 傳到我的手機：碰面點（`packages/relay`）

> 狀態：現行（最後確認 2026-11-12）。**程式與本機測試完成；尚未部署**（部署需要業主自己的 Cloudflare 帳號）。
> 涵蓋：packages/relay/src/**

> 2026-11-12。對應[提案](proposals/send-to-phone-2026-11-12.md)第 5 節第 4 項；加密與權杖導出見[配對與加密](send-to-phone-crypto.md)。

碰面點是一個很小的 HTTP 服務：頁面把加密後的塊放上去，手機取走。它**看不到也不驗證內容**，只驗權杖與大小；不需要帳號，不碰任何 Onden 資料庫。

## 1. 介面

路徑都以工作階段編號（22 字元 base64url）定址。回應一律帶 `Cache-Control: no-store`。

| 呼叫 | 權杖 | 說明 |
| --- | --- | --- |
| `PUT /v1/s/<編號>/hello` | 無 | 手機放回 33 位元組公鑰訊息。**先到先得**：同樣內容再放＝200，不同內容＝409；第一次放就建立工作階段（201） |
| `GET /v1/s/<編號>/hello` | 無 | 頁面取回；沒有＝404 |
| `PUT /v1/s/<編號>/o/<名稱>` | 寫入 | 放一個物件。第一次寫入時以 `X-Read-Token-Hash` 一併登記讀取權杖的雜湊。201＝新放、200＝已有且相同或可替換物件被換掉、409＝不可變物件內容不同 |
| `GET /v1/s/<編號>/o` | 讀取 | 列出 `{"objects":[{"name","size"}]}` |
| `GET /v1/s/<編號>/o/<名稱>` | 讀取 | 取回一個物件 |
| `DELETE /v1/s/<編號>` | 讀取 | 手機確認收完，整個工作階段立刻刪除（204）。之後任何呼叫都是 404；**重送這個 DELETE 得到 404 表示已經刪了，手機端要當成完成** |
| `OPTIONS …` | 無 | CORS 預檢 |

權杖放在 `Authorization: Bearer <權杖>`。物件名稱只能是：`m.<id>`（可替換，例如進度清單 `m.progress`）、`final`（最終清單，不可變）、`c.<項目編號>.<塊序號>`（塊，不可變）。
「不可變」指放了之後內容不能不同；相同內容再放是冪等的（重送沒事）。**頁面重送時必須送同樣的位元組**（加密後的位元組要留著，不要重加密）。

## 2. 規則與上限（`src/limits.ts` 一處定義）

| 規則 | 值 |
| --- | --- |
| 每個工作階段儲存上限 | 200 MB（200 × 1024² 位元組，算目前每個物件的大小；可替換物件被換掉只算新的） |
| 單一物件上限 | 4 MiB + 1 KiB（4 MiB 資料塊加標籤）；超過＝413（先看 `Content-Length`，沒有時邊讀邊數） |
| 每個工作階段物件數 | 2000 |
| 到期 | 最後一次**寫入**後 2 小時；到期**真的刪除**（Durable Object alarm，另外每次請求也先檢查，不靠 alarm 準時）。讀取不延長；頁面開著時定期替換 `m.progress` 即延長 |
| 最長壽命 | 建立後 24 小時（即使一直寫入） |
| 同時存在的工作階段 | 500（全部來源合計）；滿了＝503 |
| 每個來源（`CF-Connecting-IP`） | 每分鐘 300 次請求；每小時 10 個新工作階段；超過＝429 加 `Retry-After: 60` |
| 請求內容類型 | 只接受 `application/octet-stream`（含參數可），其他＝415 |
| CORS | `Access-Control-Allow-Origin` 預設 `*`（沒有 cookie，只有 Bearer 權杖）；部署時可用 `ALLOWED_ORIGIN` 限定成單一頁面來源。方法只開 `GET, PUT, DELETE, OPTIONS`，標頭只開 `authorization, content-type, x-read-token-hash`，不開憑證 |
| 權杖比對 | 對呈上的權杖做 SHA-256 後與登記的雜湊以常數時間比較；權杖在第一次寫入時登記雜湊，之後不能改 |
| 不洩漏存在與否 | 錯權杖、沒有這個工作階段、沒有這個物件＝**同一個 404 與同一段內容**（沒帶權杖＝401，與是否存在無關）。時間差沒有量測 |

## 3. 程式怎麼分

- `sessionCore.ts`：一個工作階段的全部規則，用 `SessionStorage` 介面；所有操作串成一條佇列（權杖雜湊與儲存讀寫之間會讓出執行權，否則並行寫入會互相蓋掉）。
- `limiterCore.ts`：每來源限速與全域工作階段數。登記表的每筆記著「最晚何時一定結束」，所以釋放失敗也會自己恢復。
- `handler.ts`：`Request → Response`，路由、CORS、內容類型、大小與權杖格式；可在 Worker、Node 22 與測試裡原樣執行。
- `worker.ts`：把以上放到 Cloudflare Durable Object（SQLite）：每個工作階段一個物件、每個來源一個限速物件、一個登記物件。
  物件內容切成 1 MiB 一片存放，因為 SQLite 後端的單一值有大小上限（**未查證**：我記得約 2 MB，沒能打開官方頁面確認，所以保守切開）。
- `memory.ts`：整套在記憶體裡跑（測試用）。

### 測試與沒測到的

- `relay.test.ts`（30 個）：整套規則，跑在記憶體實作上，時間可控：正常流程（含真的配對與加密）、錯權杖、超過上限、到期刪除、重複放同一塊、並行、沒登記的工作階段、速率限制。
- `workers.runtime.test.ts`（2 個）：用 Miniflare 在本機的 workerd（真的 Workers 執行環境）跑真的 `worker.ts`：超過一片大小的物件的存取、新工作階段速率限制。**沒有帳號、沒有網路。**
- **沒有在真的執行環境測到**：Durable Object alarm 到期（Miniflare 沒有調時間的辦法；到期邏輯在記憶體實作上用可控時間測過，alarm 的接線沒有）、
  `DurableObjectState.id.name`（放掉全域登記槽位用；若執行環境沒給名字就跳過，登記表會依最晚結束時間自己清掉）、
  SQLite 後端的實際單值上限、真實流量下的延遲。部署後要補一次：放一個工作階段、等 2 小時確認消失。

## 4. 在自己的 Cloudflare 帳號部署（業主照做；本任務沒有做任何一步）

前提：有 Cloudflare 帳號，Workers 與 Durable Objects 可用（**未查證**：Durable Objects 在免費方案是否只能用 SQLite 後端——本專案用的就是 SQLite 後端，`wrangler.jsonc` 的 `new_sqlite_classes`）。

1. 在本機 repo 根目錄 `npm ci`，進入 `packages/relay`。
2. `npx wrangler login`（瀏覽器登入你的帳號）。`wrangler.jsonc` 裡**沒有**帳號資訊，不需要填 `account_id`（登入後 wrangler 會問或自動帶）。
3. 第一次部署：`npx wrangler deploy`。會建立 Worker `onden-relay` 與三個 Durable Object 類別（遷移 `v1`）。輸出的網址 `https://onden-relay.<你的子網域>.workers.dev` 就是碰面點網址。
4. （建議）限定來源：編輯 `wrangler.jsonc` 的 `vars`，加上 `"ALLOWED_ORIGIN": "https://<公開瀏覽器版的網址>"`，再部署一次。
5. 驗證：`curl -i https://<碰面點網址>/v1/s/AAAAAAAAAAAAAAAAAAAAAA/hello` 應為 404 與 `{"error":"not_found",...}`。
6. 把碰面點網址交給前端設定（前端任務決定放在哪裡）。
7. 觀察用量：Cloudflare 儀表板 › Workers & Pages › onden-relay › Metrics；Durable Objects 的請求數與儲存量在同頁。
8. 不用時刪掉：`npx wrangler delete`（工作階段資料都是 2 小時內會消失的暫存）。

## 5. 免費額度下的容量估算

官方限制與價格頁（要自己打開確認，本任務的沙箱連不到）：
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/

下面的「免費額度」數字**全部未查證**（只是我記憶中的量級，請以上面三頁為準）；「每次傳送用掉多少」是從本程式的常數推算，可信。

每次傳送（一個工作階段）的請求數：1（hello）＋ 1（頁面取 hello）＋ 每塊 1 次寫入 ＋ 進度清單替換（頁面每 N 秒一次，例：每 30 秒、開 1 小時＝120 次）＋ 手機列出 ＋ 每塊 1 次讀取 ＋ 1 次刪除；
每個請求在 Worker 之外還會呼叫限速物件 1 次、（只有 hello 與刪除）登記物件與工作階段物件 1–2 次。
例：一堂課 20 MB 講義（1 MiB 塊約 20 塊）＋ 30 則筆記：約 20×2 ＋ 30×2 ＋ 120 ＋ 10 ≈ 230 個請求，約 3 倍的物件呼叫。

| 資源 | 免費額度（**未查證**） | 一次傳送用量（估） | 粗估每天可傳送次數 |
| --- | --- | --- | --- |
| Worker 請求 | 約每天 10 萬 | ≈ 230 | 數百次 |
| Durable Object 請求 | 約每天 10 萬 | ≈ 700 | 約 140 次 |
| SQLite 儲存列讀寫、儲存量 | 有每日讀寫列數與總量上限（未查證） | 每塊 1 MiB 存成 1 片；一次寫入 20 MB＝20 片，刪除時一併讀寫 | 以讀寫列數為準，需實測 |

結論：個人使用綽綽有餘；瓶頸會是 Durable Object 請求數，而不是儲存量（工作階段最多 200 MB、2 小時就刪）。免費額度是否夠用要部署後看儀表板確認。
同時上限 500 個工作階段 × 200 MB ＝ 100 GB 理論上限遠大於免費儲存額度（未查證），個人使用請調低 `MAX_ACTIVE_SESSIONS`（`src/limits.ts`）。

## 6. 改放在自己的伺服器上的一個公開端點

目標：伺服器在 VPN 裡時，另外放一個**只做這件事**的公開端點（建議放在另一個容器／主機，不和 Onden 主服務共用網路與資料庫）。

- 要改的只有「儲存與時鐘」那一層：實作 `SessionStorage`（`getMeta/putMeta/getBlob/putBlob/deleteAll/setAlarm/deleteAlarm`）與 `KeyValueStorage`，
  例如用檔案或 SQLite；`setAlarm` 換成一個每分鐘掃描到期工作階段並呼叫 `core.onAlarm()` 的計時器。`memory.ts` 的 `createMemoryRelay` 是一個完整的接線範例。
- `handler.ts` 是 `Request → Response`，Node 22 可直接用（例如接在 `http.createServer` 或 Hono 上）；來源位址要從反向代理的標頭（改 `cf-connecting-ip` 那一行）取，**不要信任客戶端自己給的轉送標頭**。
- 必須放在 https 後面（權杖在標頭裡）；反向代理要擋過大的請求本文，並把請求逾時設得夠長（4 MiB 塊在慢網路上要幾十秒）。
- 單機只有一個行程時，`SessionCore` 的佇列與每個工作階段一個物件的對應就夠了；多個行程要換成能做到「每個工作階段同一時間只有一個寫入者」的儲存（資料庫交易或鎖）。
- 不要接到 Onden 的資料庫，也不要讓它能連進 VPN。
