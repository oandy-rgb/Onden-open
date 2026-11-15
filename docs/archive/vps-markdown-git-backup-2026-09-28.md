# VPS Markdown 的本機 Git 備份（2026-09-28）

> 狀態：歷史紀錄（最後確認 2026-11-01）

使用者要求往後只傳 `.md`，並在新建的
`/var/home/oandy/桌面/git/Onden-notes` 倉庫保留 Git 歷史。該倉庫有
`git@github.com:oandy-rgb/Onden-notes.git` 遠端；SSH 查詢成功且遠端
沒有 commit。未登入的 GitHub 公開 API 回 `404`，與私有倉庫一致，
但本輪尚未把筆記推送到遠端。

VPS 正式資料庫只有一個工作區；匯出時有 7 個 live、非 hidden 的
`content` 節點。`scripts/export-vps-markdown.cjs` 在既有後端容器內以
唯讀查詢取得文字，不新增服務或安裝依賴。每篇以固定 UUID 為檔名，
frontmatter 保留 ID、標題、slug、父節點 ID、來源、更新時間和直接標籤
slug；可解析的 `onden://node/<id>` 連結改為同目錄 `.md` 連結。
先在容器與 VPS `/tmp` 產生僅有 `.md` 的暫存，再傳到本機；暫存已清理。

本機倉庫根目錄設為 `700`、筆記檔設為 `600`。7 個檔名與 frontmatter ID
相符，傳輸後的 checksum 比對沒有差異；只暫存並提交了 7 個 `.md`，
本機 Git 提交為 `9646426`。當時沒有媒體引用或未轉換的 Onden 節點連結。
沒有把 DB dump、content tar、密鑰或非 `.md` 檔案放進此 Git 提交。

此匯出是伺服器管理備份，不套用單一登入者的讀取政策；若未來工作區
不只一個，腳本會拒絕匯出，避免混在同一組檔案。它只涵蓋目前 live、
非 hidden 的 content 正文，不涵蓋垃圾桶、版本、事件、任務狀態、
白板、標籤 schema、其他屬性或媒體位元組。Git 歷史可追蹤之後的
Markdown 快照，不能代替完整工作區還原。若日後筆記有媒體引用，
`.md` 中的 `/api/media/...` 仍指向 Onden 服務。

先前傳到 `Onden-notes` 的本機 DB/content 備份目錄，在本輪開始前
已不在該倉庫；VPS 上的原始備份
`/srv/onden/backups/manual-20260928134954` 仍存在。

後續使用 `scripts/backup-vps-markdown-git.sh` 從本機執行：它鎖定單一工作，
要求筆記倉庫先為乾淨狀態，從既有後端容器匯出，透過 SSH 串流暫存
Markdown，核對數量與 ID 後更新 UUID 檔。只有快照改變才建立本機 Git
提交；不推送遠端。失敗會清理暫存並回復本輪對筆記倉庫的改動，保留上次
成功提交。實測同一份 7 篇重跑回 `unchanged`；模擬 SSH 拒絕連線後，
本機仍是 `9646426`、7 個 `.md` 且工作樹乾淨。

Codex 本機排程 `onden-markdown-git` 已啟用，每天台灣時間 **13:00**
執行一次。單次失敗視為略過，不重試；下一次排程再試。這是本機排程，
電腦與桌面程式需在排程時可用；若無法連到 VPS，當天沒有新備份。
排程使用本機 Onden 專案及低資源模型設定，僅執行上述腳本；
`~/.codex/rules/onden-markdown-backup.rules` 只允許該腳本越過預設
沙箱存取 VPS 與相鄰筆記倉庫，規則檢查結果為 `allow`。
