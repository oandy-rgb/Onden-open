# 讓 AI 在一台機器上自動領工作（MCP 角色）

「加入 AI 角色」有兩種方式：**API**（Onden 用你的金鑰呼叫 AI）與 **MCP**（你自己的 AI 用戶端連進來）。
MCP 角色有兩種用法，角色設定完全一樣：

- **手動**：你在自己的電腦上開一個支援 MCP 的 AI 用戶端，貼上角色的 MCP 金鑰，想用的時候叫它做事。
- **自動**：把一個支援 MCP 的命令列 AI 工具放在某台機器上（家裡的伺服器、VPS、樹莓派都可以），再配一支很短的輪詢腳本。
  你在筆記裡 `@` 這個角色時，請求會先排隊；腳本發現後把工作交給 AI 工具，結果寫回筆記。

不論哪一種，Onden 都不會替 AI 打電話，只會等它來。排隊中的請求會一直等到用戶端來領（或到期）；
角色卡片上的「上次來」是用戶端最近一次來問有沒有工作、或呼叫 MCP 工具的時間。

## 你需要

1. 一個 MCP 角色（設定 › 空間與成員 › 加入 AI 角色 › MCP），並替它加入要工作的空間。
2. 角色的 MCP 金鑰（建立時只顯示一次；弄丟了就在角色卡片另外發一把）。金鑰權限只到角色所在的空間。
3. 一個支援 MCP、能在命令列一次跑完一件事的 AI 工具（以下稱「AI 工具」）。它怎麼安裝、登入哪個帳號、用哪個模型，都由你自己決定，Onden 不管。
4. 一支輪詢腳本（下面有範例）。

## 領工作的協定

腳本只需要會四個 HTTP 呼叫，都用角色金鑰當 `Authorization: Bearer`：

| 呼叫 | 作用 |
| --- | --- |
| `GET /api/mcp/sessions/pending?wait=25` | 長輪詢：有排隊的請求就立刻回，沒有就最多等 25 秒。回 `{ "sessions": [{ "id": … }] }` |
| `POST /api/mcp/sessions/{id}/claim` | 領走一件（同時只有一個用戶端領得到）。回請求內容與一把只在這件事有效的 **session 金鑰** |
| `POST /api/mcp/sessions/{id}/events`（選用） | 回報進度 |
| `POST /api/mcp/sessions/{id}/finish` | 交回結果：`{"status":"completed","result_markdown":"…"}` 或 `{"status":"failed"}` |

`claim` 回傳的 `rendered` 是已經組好的提示（`system` 加 `messages`），`mcp.token` 是這一件事專用的 MCP 金鑰：
讓 AI 工具用它連到 `https://你的網址/api/mcp`，AI 就只能讀寫這則筆記所在的空間，且在這件事結束後失效。

## 輪詢腳本範例

下面是最小的做法（bash、curl、jq）。`AI_TOOL_COMMAND` 換成你的 AI 工具「讀 stdin 的提示、把答案印到 stdout」的呼叫方式；
要讓它能呼叫 Onden 的 MCP 工具，就把 `mcp.token` 用該工具設定 MCP 伺服器的方式傳進去。

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://你的網址"                      # Onden 的網址
ROLE_KEY="$(cat /etc/onden/role.key)"        # 角色的 MCP 金鑰（檔案權限設成只有執行者能讀）
AUTH=(-H "Authorization: Bearer $ROLE_KEY")

while true; do
  # 長輪詢；斷線或逾時就稍等再來，不要緊密重試
  ids=$(curl -fsS "${AUTH[@]}" "$BASE/api/mcp/sessions/pending?wait=25" | jq -r '.sessions[].id' || true)
  [ -z "$ids" ] && { sleep 2; continue; }
  for id in $ids; do
    claim=$(curl -fsS -X POST "${AUTH[@]}" "$BASE/api/mcp/sessions/$id/claim") || continue   # 被別人領走就換下一件
    session_key=$(jq -r '.mcp.token' <<<"$claim")
    prompt=$(jq -r '.rendered.messages | map(.content) | join("\n\n")' <<<"$claim")
    system=$(jq -r '.rendered.system' <<<"$claim")
    SESSION_KEY="$session_key" ONDEN_MCP_URL="$BASE/api/mcp" \
      answer=$(printf '%s\n\n%s' "$system" "$prompt" | AI_TOOL_COMMAND) || answer=""
    if [ -n "$answer" ]; then
      jq -n --arg r "$answer" '{status:"completed",result_markdown:$r}'
    else
      jq -n '{status:"failed",fail_code:"agent_error"}'
    fi | curl -fsS -X POST -H "Authorization: Bearer $session_key" -H 'content-type: application/json' \
          -d @- "$BASE/api/mcp/sessions/$id/finish" >/dev/null
  done
done
```

把腳本交給系統的服務管理（systemd、容器的重啟政策等）常駐，掛了會自動重啟。

## 注意

- 領走之後要在期限內交回（`claim` 回傳的 `session.deadline_at`）；逾時的請求會被標成失敗，再由人重送。
- 同一個角色同時最多跑幾件有上限，超過時 `claim` 回 429，稍後再試。
- 請求被取消時，`GET /api/mcp/sessions/{id}`（用 session 金鑰）會顯示已取消，長時間的工作可以偶爾看一眼。
- 角色金鑰等於這個角色的身分：放在只有輪詢腳本讀得到的地方；懷疑外洩就到角色卡片撤銷並重發。
- 用 MCP 金鑰連進來的 AI 是否能直接改筆記，看角色的「審核規則」（先給我看／直接修改，可復原）。
