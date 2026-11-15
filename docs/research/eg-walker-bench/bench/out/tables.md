# Eg-walker 測試台原始數字

> 狀態：現行（`src/makeTables.ts` 由 `bench/out/*.json` 自動產生；解讀見上一層的 report.md）（最後確認 2026-11-01）

## Node（v22.23.4，Intel(R) Xeon(R) Processor @ 2.10GHz，校準 72 ms）

**(a) 只處理分岔那段**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 0.79 ms / 1.26 ms | 10.4 ms / 16.0 ms | 0.20 ms / 0.28 ms | 0.38 ms / 0.51 ms |
| 10KB-100 | 2.63 ms / 4.26 ms | 68.8 ms / 81.9 ms | 0.54 ms / 0.88 ms | 0.91 ms / 2.11 ms |
| 10KB-1000 | 240 ms / 359 ms | 741 ms / 862 ms | 4.16 ms / 5.12 ms | 3.86 ms / 12.0 ms |
| 50KB-10 | 2.97 ms / 3.51 ms | 34.8 ms / 51.6 ms | 0.43 ms / 0.62 ms | 0.27 ms / 0.39 ms |
| 50KB-100 | 3.45 ms / 5.71 ms | 252 ms / 286 ms | 0.85 ms / 1.40 ms | 0.98 ms / 2.37 ms |
| 50KB-1000 | 50.0 ms / 79.1 ms | 3.1 s / 3.2 s | 4.73 ms / 7.19 ms | 6.61 ms / 18.2 ms |
| 200KB-10 | 8.70 ms / 12.7 ms | 253 ms / 311 ms | 1.65 ms / 2.25 ms | 0.50 ms / 0.76 ms |
| 200KB-100 | 9.61 ms / 14.2 ms | 1.1 s / 1.3 s | 2.68 ms / 3.07 ms | 1.09 ms / 2.78 ms |
| 200KB-1000 | 25.1 ms / 33.6 ms | 10.5 s / 10.5 s* | 6.59 ms / 9.60 ms | 6.68 ms / 21.7 ms |

**(b) 整份歷史從頭重放**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 未跑 | 77.5 ms / 129 ms | 0.38 ms / 0.45 ms | 0.44 ms / 0.69 ms |
| 10KB-100 | 未跑 | 110 ms / 123 ms | 0.93 ms / 1.11 ms | 0.89 ms / 2.19 ms |
| 10KB-1000 | 未跑 | 802 ms / 833 ms | 3.83 ms / 5.54 ms | 4.24 ms / 12.9 ms |
| 50KB-10 | 未跑 | 2.0 s / 2.2 s | 0.60 ms / 0.89 ms | 0.42 ms / 0.61 ms |
| 50KB-100 | 未跑 | 2.5 s / 2.5 s | 1.72 ms / 1.95 ms | 0.94 ms / 2.56 ms |
| 50KB-1000 | 未跑 | 5.6 s / 5.8 s | 5.92 ms / 8.92 ms | 8.88 ms / 21.9 ms |
| 200KB-10 | 未跑 | 38.2 s / 38.2 s* | 2.18 ms / 3.24 ms | 1.15 ms / 1.72 ms |
| 200KB-100 | 未跑 | 41.6 s / 41.6 s* | 3.32 ms / 4.32 ms | 1.49 ms / 3.64 ms |
| 200KB-1000 | 未跑 | 49.1 s / 49.1 s* | 8.52 ms / 13.1 ms | 7.86 ms / 19.5 ms |

**(c) 載入既有文件＋套一筆遠端修改**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 0.77 ms / 1.04 ms | 9.69 ms / 10.9 ms | 0.41 ms / 0.59 ms | 0.42 ms / 0.64 ms |
| 10KB-100 | 0.56 ms / 0.80 ms | 6.49 ms / 10.6 ms | 0.63 ms / 0.88 ms | 0.56 ms / 0.70 ms |
| 10KB-1000 | 0.60 ms / 0.85 ms | 18.0 ms / 27.7 ms | 1.78 ms / 2.55 ms | 1.19 ms / 1.80 ms |
| 50KB-10 | 1.99 ms / 3.24 ms | 28.0 ms / 46.3 ms | 0.89 ms / 1.35 ms | 0.61 ms / 1.05 ms |
| 50KB-100 | 2.16 ms / 3.34 ms | 31.9 ms / 44.4 ms | 1.49 ms / 1.77 ms | 0.79 ms / 1.32 ms |
| 50KB-1000 | 2.12 ms / 3.07 ms | 42.6 ms / 65.0 ms | 2.68 ms / 3.90 ms | 1.54 ms / 2.36 ms |
| 200KB-10 | 12.5 ms / 14.0 ms | 158 ms / 184 ms | 3.39 ms / 5.08 ms | 1.81 ms / 2.64 ms |
| 200KB-100 | 12.7 ms / 15.6 ms | 155 ms / 171 ms | 3.64 ms / 5.35 ms | 2.43 ms / 2.74 ms |
| 200KB-1000 | 9.79 ms / 13.5 ms | 154 ms / 161 ms | 5.15 ms / 7.70 ms | 2.95 ms / 4.25 ms |

**論文 trace，(b) 整份重放**

| trace | 參考實作 | diamond-types | 我們的原型 | 結果對得上預期 |
| --- | --- | --- | --- | --- |
| automerge-paper | 未跑 | 3.16 ms / 4.78 ms | 25.0 ms / 40.9 ms | dt ✓ 原型 ✓ |
| seph-blog1 | 未跑 | 5.80 ms / 6.89 ms | 18.4 ms / 21.1 ms | dt ✓ 原型 ✓ |
| friendsforever | 1.3 s / 1.3 s | 10.9 ms / 16.3 ms | 29.5 ms / 48.6 ms | dt ✓ 原型 ✓ |
| clownschool | 1.7 s / 1.8 s | 22.9 ms / 25.9 ms | 89.2 ms / 102 ms | dt ✓ 原型 ✓ |
| node_nodecc | 未跑 | 126 ms / 166 ms | 158 ms / 198 ms | dt ✓ 原型 ✓ |
| git-makefile | 未跑 | 79.1 ms / 90.1 ms | 281 ms / 346 ms | dt ✓ 原型 ✗ |

## chromium 153.0.8010.12，降速 4×（校準 319 ms）

**(a) 只處理分岔那段**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 4.10 ms / 7.20 ms | 31.7 ms / 42.0 ms | 0.80 ms / 1.90 ms | 1.40 ms / 2.70 ms |
| 10KB-100 | 12.3 ms / 21.0 ms | 173 ms / 186 ms | 2.20 ms / 4.00 ms | 6.00 ms / 10.4 ms |
| 10KB-1000 | 1.0 s / 1.3 s | 3.4 s / 3.5 s | 11.5 ms / 18.0 ms | 18.9 ms / 25.2 ms |
| 50KB-10 | 9.00 ms / 16.8 ms | 101 ms / 152 ms | 1.20 ms / 2.20 ms | 1.40 ms / 2.90 ms |
| 50KB-100 | 13.3 ms / 20.4 ms | 954 ms / 1.1 s | 3.00 ms / 4.70 ms | 6.80 ms / 11.4 ms |
| 50KB-1000 | 214 ms / 342 ms | 未跑 | 21.2 ms / 30.3 ms | 32.7 ms / 52.3 ms |
| 200KB-10 | 37.8 ms / 56.3 ms | 644 ms / 960 ms | 4.60 ms / 6.90 ms | 2.30 ms / 3.60 ms |
| 200KB-100 | 36.8 ms / 40.5 ms | 5.2 s / 5.6 s | 6.50 ms / 9.80 ms | 7.00 ms / 11.5 ms |
| 200KB-1000 | 86.1 ms / 105 ms | 未跑 | 25.2 ms / 31.8 ms | 33.8 ms / 43.9 ms |

**(b) 整份歷史從頭重放**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | — | 273 ms / 413 ms | 1.40 ms / 2.60 ms | 1.40 ms / 2.60 ms |
| 10KB-100 | — | 412 ms / 495 ms | 3.30 ms / 5.40 ms | 7.50 ms / 13.3 ms |
| 10KB-1000 | — | 3.4 s / 3.5 s | 15.3 ms / 20.8 ms | 25.4 ms / 43.2 ms |
| 50KB-10 | — | 7.4 s / 7.4 s* | 2.40 ms / 4.00 ms | 1.60 ms / 3.00 ms |
| 50KB-100 | — | 9.3 s / 9.3 s* | 4.80 ms / 8.10 ms | 7.30 ms / 13.1 ms |
| 50KB-1000 | — | 未跑 | 27.2 ms / 45.0 ms | 37.2 ms / 45.9 ms |
| 200KB-10 | — | 未跑 | 7.70 ms / 12.0 ms | 3.10 ms / 5.30 ms |
| 200KB-100 | — | 未跑 | 9.70 ms / 14.7 ms | 8.20 ms / 12.2 ms |
| 200KB-1000 | — | 未跑 | 33.3 ms / 40.3 ms | 40.2 ms / 52.8 ms |

**(c) 載入既有文件＋套一筆遠端修改**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 2.50 ms / 4.20 ms | 22.6 ms / 37.8 ms | 1.60 ms / 2.80 ms | 1.60 ms / 3.40 ms |
| 10KB-100 | 2.40 ms / 4.20 ms | 21.2 ms / 35.6 ms | 2.30 ms / 3.80 ms | 2.05 ms / 4.40 ms |
| 10KB-1000 | 1.80 ms / 3.10 ms | 53.4 ms / 68.9 ms | 7.20 ms / 11.5 ms | 5.00 ms / 7.60 ms |
| 50KB-10 | 8.50 ms / 13.0 ms | 81.2 ms / 103 ms | 4.60 ms / 6.50 ms | 2.40 ms / 3.80 ms |
| 50KB-100 | 8.50 ms / 11.7 ms | 115 ms / 169 ms | 4.50 ms / 7.30 ms | 2.70 ms / 4.70 ms |
| 50KB-1000 | 8.00 ms / 11.3 ms | 119 ms / 199 ms | 10.4 ms / 12.8 ms | 6.10 ms / 9.40 ms |
| 200KB-10 | 36.4 ms / 58.5 ms | 399 ms / 480 ms | 12.5 ms / 17.7 ms | 5.40 ms / 7.50 ms |
| 200KB-100 | 34.2 ms / 44.2 ms | 500 ms / 761 ms | 12.9 ms / 15.3 ms | 5.90 ms / 8.20 ms |
| 200KB-1000 | 35.9 ms / 66.9 ms | 461 ms / 582 ms | 19.9 ms / 28.0 ms | 7.90 ms / 10.6 ms |

| trace (b) | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- |
| automerge-paper | — | 9.70 ms / 16.4 ms | 69.3 ms / 93.3 ms |
| seph-blog1 | — | 15.4 ms / 26.6 ms | 28.8 ms / 40.7 ms |
| friendsforever | 5.0 s / 5.3 s | 41.5 ms / 69.8 ms | 85.5 ms / 138 ms |
| clownschool | 6.2 s / 6.5 s | 59.5 ms / 70.9 ms | 155 ms / 198 ms |
| node_nodecc | — | 435 ms / 487 ms | 439 ms / 518 ms |
| git-makefile | — | 266 ms / 294 ms | 697 ms / 845 ms |

## chromium 153.0.8010.12，降速 1×（校準 68 ms）

**(a) 只處理分岔那段**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 0.60 ms / 1.00 ms | — | 0.20 ms / 0.30 ms | 0.20 ms / 0.40 ms |
| 10KB-100 | 2.70 ms / 4.40 ms | — | 0.50 ms / 0.70 ms | 1.30 ms / 2.10 ms |
| 10KB-1000 | 223 ms / 249 ms | — | 2.50 ms / 3.70 ms | 4.10 ms / 7.50 ms |
| 50KB-10 | 1.70 ms / 2.30 ms | — | 0.30 ms / 0.40 ms | 0.20 ms / 0.30 ms |
| 50KB-100 | 2.90 ms / 4.40 ms | — | 0.70 ms / 0.90 ms | 1.50 ms / 2.30 ms |
| 50KB-1000 | 40.8 ms / 60.8 ms | — | 4.70 ms / 6.90 ms | 6.70 ms / 11.1 ms |
| 200KB-10 | 7.40 ms / 10.4 ms | — | 0.90 ms / 1.30 ms | 0.40 ms / 0.50 ms |
| 200KB-100 | 8.20 ms / 11.9 ms | — | 1.30 ms / 2.00 ms | 1.60 ms / 2.50 ms |
| 200KB-1000 | 19.9 ms / 23.5 ms | — | 5.60 ms / 8.00 ms | 6.20 ms / 9.70 ms |

**(b) 整份歷史從頭重放**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | — | — | 0.20 ms / 0.30 ms | 0.20 ms / 0.40 ms |
| 10KB-100 | — | — | 0.60 ms / 0.80 ms | 1.30 ms / 1.90 ms |
| 10KB-1000 | — | — | 3.20 ms / 3.50 ms | 4.90 ms / 8.80 ms |
| 50KB-10 | — | — | 0.40 ms / 0.60 ms | 0.30 ms / 0.40 ms |
| 50KB-100 | — | — | 1.00 ms / 1.50 ms | 1.40 ms / 2.00 ms |
| 50KB-1000 | — | — | 5.60 ms / 7.50 ms | 8.90 ms / 13.9 ms |
| 200KB-10 | — | — | 1.50 ms / 2.20 ms | 0.50 ms / 0.60 ms |
| 200KB-100 | — | — | 2.00 ms / 2.90 ms | 1.70 ms / 2.70 ms |
| 200KB-1000 | — | — | 7.10 ms / 10.9 ms | 9.65 ms / 13.9 ms |

**(c) 載入既有文件＋套一筆遠端修改**（中位數 / p95；\* 只量了一次）

| 情境 | 現行 diff3 | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- | --- |
| 10KB-10 | 0.40 ms / 0.70 ms | — | 0.30 ms / 0.40 ms | 0.30 ms / 0.40 ms |
| 10KB-100 | 0.40 ms / 0.70 ms | — | 0.40 ms / 0.60 ms | 0.40 ms / 0.60 ms |
| 10KB-1000 | 0.30 ms / 0.50 ms | — | 1.40 ms / 1.70 ms | 0.80 ms / 1.20 ms |
| 50KB-10 | 1.70 ms / 2.60 ms | — | 0.80 ms / 1.20 ms | 0.50 ms / 0.70 ms |
| 50KB-100 | 1.70 ms / 2.50 ms | — | 0.90 ms / 1.10 ms | 0.60 ms / 0.80 ms |
| 50KB-1000 | 1.70 ms / 1.90 ms | — | 2.10 ms / 3.00 ms | 1.00 ms / 1.60 ms |
| 200KB-10 | 7.30 ms / 8.40 ms | — | 2.60 ms / 3.20 ms | 1.10 ms / 1.40 ms |
| 200KB-100 | 7.30 ms / 10.7 ms | — | 2.80 ms / 4.00 ms | 1.20 ms / 1.60 ms |
| 200KB-1000 | 7.60 ms / 10.5 ms | — | 4.30 ms / 5.30 ms | 1.70 ms / 2.50 ms |

| trace (b) | 參考實作 | diamond-types | 我們的原型 |
| --- | --- | --- | --- |
| automerge-paper | — | 2.70 ms / 3.40 ms | 17.7 ms / 25.1 ms |
| seph-blog1 | — | 3.80 ms / 5.50 ms | 7.50 ms / 10.4 ms |
| friendsforever | — | 10.5 ms / 14.3 ms | 25.0 ms / 35.7 ms |
| clownschool | — | 15.4 ms / 21.3 ms | 42.0 ms / 62.2 ms |
| node_nodecc | — | 94.7 ms / 140 ms | 103 ms / 153 ms |
| git-makefile | — | 59.1 ms / 74.7 ms | 167 ms / 230 ms |

## 優化各貢獻多少（Node，中位數 / p95）

| 情境 | 操作 | V0 無優化 | V1 ＋run-length | V2 ＋分段陣列 | V3 ＋跳過線性（完整原型） |
| --- | --- | --- | --- | --- | --- |
| 200KB-100 | a | 31.0 ms / 43.0 ms | 1.20 ms / 3.66 ms | 1.14 ms / 3.01 ms | 1.06 ms / 2.58 ms |
| 200KB-100 | b | 38.4 s / 38.4 s* | 1.43 ms / 4.41 ms | 1.27 ms / 3.22 ms | 1.31 ms / 3.17 ms |
| 200KB-1000 | a | 2.0 s / 2.1 s | 37.5 ms / 56.2 ms | 6.47 ms / 18.9 ms | 7.56 ms / 22.2 ms |
| 200KB-1000 | b | 49.6 s / 49.6 s* | 35.9 ms / 49.9 ms | 7.69 ms / 19.8 ms | 8.07 ms / 20.0 ms |
| 50KB-1000 | a | 1.6 s / 1.6 s | 31.9 ms / 47.0 ms | 6.24 ms / 18.0 ms | 5.73 ms / 16.7 ms |
| 50KB-1000 | b | 5.2 s / 5.7 s | 32.4 ms / 40.9 ms | 6.86 ms / 17.3 ms | 6.54 ms / 18.0 ms |
| friendsforever | b | 1.1 s / 1.2 s | 78.8 ms / 114 ms | 33.8 ms / 57.6 ms | 27.1 ms / 48.3 ms |
| clownschool | b | 1.3 s / 1.4 s | 712 ms / 856 ms | 84.4 ms / 132 ms | 62.3 ms / 83.9 ms |
| git-makefile | b | 未跑 | 未跑 | 195 ms / 243 ms | 189 ms / 208 ms |
| node_nodecc | b | 未跑 | 未跑 | 970 ms / 1.1 s | 128 ms / 167 ms |
| automerge-paper | b | 未跑 | 未跑 | 252 ms / 327 ms | 23.5 ms / 33.9 ms |

## 序列化後的歷史大小（base＋A＋B，原始 / gzip）

| 情境 | 筆記本身（UTF-8） | 我們的原型 | diamond-types | 參考實作（JSON） |
| --- | --- | --- | --- | --- |
| 10KB-10 | 10.0 KB | 10.6 KB / 3.7 KB | 5.3 KB / 4.4 KB | 245.2 KB / 25.3 KB |
| 10KB-100 | 10.0 KB | 14.7 KB / 5.2 KB | 7.5 KB / 6.2 KB | 322.3 KB / 32.8 KB |
| 10KB-1000 | 10.2 KB | 51.0 KB / 18.1 KB | 26.4 KB / 21.3 KB | 973.9 KB / 105.1 KB |
| 50KB-10 | 50.1 KB | 50.6 KB / 14.0 KB | 22.8 KB / 18.0 KB | 1.12 MB / 116.5 KB |
| 50KB-100 | 50.1 KB | 55.5 KB / 15.9 KB | 25.2 KB / 20.0 KB | 1.26 MB / 129.0 KB |
| 50KB-1000 | 50.1 KB | 98.4 KB / 32.3 KB | 49.5 KB / 39.1 KB | 2.04 MB / 211.7 KB |
| 200KB-10 | 200.1 KB | 200.6 KB / 51.0 KB | 88.9 KB / 69.1 KB | — |
| 200KB-100 | 200.0 KB | 205.5 KB / 53.0 KB | 91.0 KB / 71.0 KB | — |
| 200KB-1000 | 200.0 KB | 250.0 KB / 70.2 KB | 115.6 KB / 90.7 KB | — |

| trace | 單位操作數 | 最終文字 | 我們的原型 | diamond-types（.dt） | 參考實作（JSON） |
| --- | --- | --- | --- | --- | --- |
| automerge-paper | 259778 | 102.4 KB | 687.8 KB / 75.0 KB | 103.8 KB / 87.3 KB | 9.05 MB / 770.8 KB |
| seph-blog1 | 368209 | 55.4 KB | 486.4 KB / 111.0 KB | 154.1 KB / 122.8 KB | 12.22 MB / 762.2 KB |
| friendsforever | 26078 | 20.9 KB | 63.2 KB / 39.9 KB | 34.3 KB / 27.6 KB | 1.14 MB / 120.6 KB |
| clownschool | 24326 | 20.7 KB | 248.1 KB / 124.4 KB | 46.2 KB / 33.8 KB | 1.20 MB / 133.3 KB |
| node_nodecc | 947337 | 37.2 KB | 602.6 KB / 218.0 KB | 327.1 KB / 253.0 KB | — |
| git-makefile | 348819 | 111.0 KB | 282.2 KB / 113.2 KB | 158.2 KB / 129.0 KB | 12.08 MB / 936.2 KB |

## 打包後大小（minify，esm）

| 項目 | 原始 | gzip | brotli |
| --- | --- | --- | --- |
| proto：合併引擎（mergeIntoBranch＋replay，含沿用的因果圖） | 17.4 KB | 6.9 KB | 6.3 KB |
| proto：引擎＋序列化格式 | 19.4 KB | 7.6 KB | 6.9 KB |
| eg-walker-reference（原樣） | 12.8 KB | 5.0 KB | 4.6 KB |
| 現行 diff3（bodyMerge＋bodyPatch） | 22.6 KB | 7.8 KB | 7.0 KB |
| diamond-types：WASM（dt_bg.wasm） | 247.2 KB | 101.4 KB | 81.6 KB |
| diamond-types：JS 綁定（dt.js） | 14.9 KB | 3.4 KB | 3.0 KB |

## 記憶體（Node，一個 case 一個程序）

| 情境 | 實作 | 操作期間 JS 堆積配置量 | 程序 RSS 峰值 |
| --- | --- | --- | --- |
| fork:10KB-100:a | 現行 diff3 | 2.8 MB | 87 MB |
| fork:10KB-100:a | 參考實作 | 3.5 MB | 94 MB |
| fork:10KB-100:a | diamond-types | 0.1 MB | 101 MB |
| fork:10KB-100:a | 我們的原型 | 0.6 MB | 88 MB |
| fork:10KB-1000:a | 現行 diff3 | 3.4 MB | 99 MB |
| fork:10KB-1000:a | 參考實作 | 5.6 MB | 103 MB |
| fork:10KB-1000:a | diamond-types | 0.2 MB | 105 MB |
| fork:10KB-1000:a | 我們的原型 | 2.5 MB | 100 MB |
| fork:50KB-1000:a | 現行 diff3 | 2.4 MB | 105 MB |
| fork:50KB-1000:a | 參考實作 | 11.7 MB | 112 MB |
| fork:50KB-1000:a | diamond-types | 0.2 MB | 112 MB |
| fork:50KB-1000:a | 我們的原型 | 4.1 MB | 98 MB |
| fork:200KB-100:a | 現行 diff3 | 7.1 MB | 106 MB |
| fork:200KB-100:a | 參考實作 | 29.0 MB | 145 MB |
| fork:200KB-100:a | diamond-types | 0.3 MB | 111 MB |
| fork:200KB-100:a | 我們的原型 | 0.8 MB | 107 MB |
| fork:200KB-1000:a | 現行 diff3 | 11.0 MB | 133 MB |
| fork:200KB-1000:a | 參考實作 | 46.5 MB | 155 MB |
| fork:200KB-1000:a | diamond-types | 0.4 MB | 141 MB |
| fork:200KB-1000:a | 我們的原型 | 4.2 MB | 132 MB |
| trace:friendsforever:b | diamond-types | 0.2 MB | 101 MB |
| trace:friendsforever:b | 我們的原型 | 5.5 MB | 110 MB |
| trace:clownschool:b | diamond-types | 0.2 MB | 125 MB |
| trace:clownschool:b | 我們的原型 | 14.1 MB | 155 MB |
| trace:node_nodecc:b | diamond-types | 0.2 MB | 128 MB |
| trace:node_nodecc:b | 我們的原型 | 7.6 MB | 135 MB |
| trace:git-makefile:b | diamond-types | 0.3 MB | 102 MB |
| trace:git-makefile:b | 我們的原型 | 17.1 MB | 114 MB |
| trace:automerge-paper:b | diamond-types | 0.3 MB | 234 MB |
| trace:automerge-paper:b | 我們的原型 | 28.8 MB | 249 MB |
| trace:friendsforever:b | 參考實作 | 8.8 MB | 107 MB |
