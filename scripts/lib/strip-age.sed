# 舊備份（2026-10 前）含 Apache AGE 擴充；現在的映像沒有它，原樣還原會在 CREATE EXTENSION 失敗。
# 兩種格式共用這一份：
#   - 純 SQL 傾印（backup.sh → restore.sh）：刪掉 age／ag_catalog 的 CREATE、COMMENT、DROP 行，以及 ag_catalog 表的資料
#     （AGE 的設定表 ag_graph、ag_label 由 pg_dump 以 COPY … FROM stdin 區塊帶出，到「\.」為止）與它的序列值。
#   - pg_restore -l 的目錄（backup-vps.sh 的 database.dump → restore.sh 與 restore-drill.sh 都用 -L）：刪掉對應的目錄項，
#     包括 ag_catalog schema 裡的每一項（TABLE DATA、SEQUENCE SET…；2026-11-22 筆電演練：只刪 schema 與 extension，
#     2026-10-31 的備份在 TABLE DATA ag_catalog 失敗）。
# 只比對這幾行的完整形式，不會誤刪名稱裡含 age 的其他物件（page、storage…）。
/^CREATE SCHEMA ag_catalog;$/d
/^CREATE EXTENSION IF NOT EXISTS age\( WITH SCHEMA ag_catalog\)\{0,1\};$/d
/^COMMENT ON EXTENSION age IS .*;$/d
/^DROP EXTENSION IF EXISTS age;$/d
/^DROP SCHEMA IF EXISTS ag_catalog;$/d
/^[0-9]*; [0-9]* [0-9]* SCHEMA - ag_catalog\( .*\)\{0,1\}$/d
/^[0-9]*; [0-9]* [0-9]* EXTENSION - age\( .*\)\{0,1\}$/d
/^[0-9]*; [0-9]* [0-9]* COMMENT - EXTENSION age\( .*\)\{0,1\}$/d
/^COPY ag_catalog\.[^ ]* .*FROM stdin;$/,/^\\\.$/d
/^SELECT pg_catalog\.setval('ag_catalog\./d
/^[0-9]*; [0-9]* [0-9]* [A-Z][A-Z ]* ag_catalog /d
