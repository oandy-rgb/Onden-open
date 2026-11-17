# 帳號救援：忘記密碼與帳號被盜

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/admin.ts, packages/backend/src/services/adminAccounts.ts

Onden 沒有「寄信重設密碼」：自架的人通常沒有郵件伺服器。取而代之的是**在伺服器的容器裡執行的管理指令**。
能執行指令的人本來就控制著你的主機，所以這些指令不開任何網路入口，也不需要額外的密碼。

以下指令都在放 `compose.yaml` 的資料夾執行，服務名稱是 `backend`：

```bash
docker compose exec backend node dist/admin.js --help
```

`--help` 會用白話列出所有指令。

## 先看有哪些帳號

```bash
docker compose exec backend node dist/admin.js users
```

每個帳號一行：email、是否為擁有者、最後登入時間（Onden 只有擁有者與成員兩種身分）。不會印出密碼或登入憑證。
「最後登入」取自目前還留著的登入狀態；從沒登入過、或登入狀態已被撤銷或過期清掉的帳號會顯示 `—`。

## 忘記密碼怎麼辦

1. 重設（把 `you@example.com` 換成你的 email）：

   ```bash
   docker compose exec backend node dist/admin.js reset-password you@example.com
   ```

2. 畫面會印出一組隨機的暫時密碼，**只顯示這一次**，請馬上抄下來。
3. 用暫時密碼登入，立刻到設定改成自己的密碼。
4. 該帳號在所有裝置上的登入狀態都會失效，需要重新登入。舊密碼不能再用。

想自己決定新密碼，從標準輸入讀入（密碼不會出現在畫面或指令歷史；長度 8 到 128 個字元，和註冊時相同）：

```bash
printf '%s' 'my-new-password' | docker compose exec -T backend node dist/admin.js reset-password you@example.com --password-stdin
```

> 如果 shell 會記錄指令歷史，改用 `read -rs PW; printf '%s' "$PW" | …`，避免密碼留在歷史裡。

只有用 email 與密碼登入的帳號能重設。用 GitHub 或 Google 登入的帳號沒有 Onden 密碼，指令會告訴你，請改從那邊救回帳號。

## 懷疑帳號被盜怎麼辦

1. 先讓該帳號所有登入狀態失效（別人手上的登入就失效了）：

   ```bash
   docker compose exec backend node dist/admin.js sessions revoke you@example.com
   ```

2. 馬上重設密碼（同樣會讓登入狀態失效）：

   ```bash
   docker compose exec backend node dist/admin.js reset-password you@example.com
   ```

3. 登入後到「使用者與 AI」檢查有沒有不認得的 AI 金鑰，有就撤銷。金鑰不是登入狀態，這兩個指令不會動它們。
4. 若連主機或 `.env` 也可能外洩，另外換掉 `BETTER_AUTH_SECRET`（換了之後所有人都要重新登入）。

## 留下什麼紀錄

每次重設或撤銷都會寫入一筆操作紀錄（「管理指令重設密碼」、「管理指令讓登入狀態失效」），操作者顯示為系統，
內容只有被讓幾個登入狀態失效，**不含密碼、密碼雜湊或 email**。指令輸出也不會把密碼寫進後端記錄。
