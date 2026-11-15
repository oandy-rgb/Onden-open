# 舊備份（2026-10 前）含 Apache AGE 擴充；現在的映像沒有它，原樣還原會在 CREATE EXTENSION 失敗。
# 兩種格式共用這一份：
#   - 純 SQL 傾印（backup.sh → restore.sh）：刪掉 age／ag_catalog 的 CREATE、COMMENT、DROP 行。
#   - pg_restore -l 的目錄（backup-vps.sh 的 database.dump → restore-drill.sh 用 -L）：刪掉對應的目錄項。
# 只比對這幾行的完整形式，不會誤刪名稱裡含 age 的其他物件（page、storage…）。
/^CREATE SCHEMA ag_catalog;$/d
/^CREATE EXTENSION IF NOT EXISTS age\( WITH SCHEMA ag_catalog\)\{0,1\};$/d
/^COMMENT ON EXTENSION age IS .*;$/d
/^DROP EXTENSION IF EXISTS age;$/d
/^DROP SCHEMA IF EXISTS ag_catalog;$/d
/^[0-9]*; [0-9]* [0-9]* SCHEMA - ag_catalog\( .*\)\{0,1\}$/d
/^[0-9]*; [0-9]* [0-9]* EXTENSION - age\( .*\)\{0,1\}$/d
/^[0-9]*; [0-9]* [0-9]* COMMENT - EXTENSION age\( .*\)\{0,1\}$/d
