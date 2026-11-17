# 版面規則檢查報告（2026-11-02）

> 狀態：歷史紀錄（寫於 2026-11-02）。第一輪結果。工具在 [`packages/frontend/e2e/layout-audit/`](../../packages/frontend/e2e/layout-audit/README.md)，違規基準在同資料夾的 `baseline.json`。
> 這個 PR **不修產品畫面**；下面的原因是讀 CSS 後的判斷，沒有逐一改了驗證。對象是瀏覽器版（Chromium），WebKit 與真機沒跑。

## 一句話結論

7 個寬度 × 23 個畫面 × 9 條規則共找到 **97 筆違規**（同一選擇器在同一畫面、寬度只算一筆），歸成 15 個問題。桌面四個寬度（1280／1440／1920／1100）與 1440 深色各只有 2–3 筆，平板 900（手機版面）9 筆；問題集中在**手機（Pixel 5）：75 筆**，主要是點擊目標不足 44px 與「擴大的點擊範圍互相蓋住」。唯一「點不到」的是白板手機工具列的「開啟」按鈕（被壓成 3.6px 寬）。業主 11/02 回報的五類畫面問題，在目前的 main 上都沒有被規則報出（#1179 另以截圖確認）；工具在修正前的版本（#1178 之前）上重現了其中兩個，另一個是已知盲點（見〈規則的驗證〉）。

## 規則的定義與誤報處理

完整定義、誤報處理與盲點在 [README](../../packages/frontend/e2e/layout-audit/README.md)。這裡只列各規則怎麼量、調過什麼、本輪結果。

| 規則 | 名稱 | 怎麼量 | 誤報處理 |
|---|---|---|---|
| R1 | 可點的東西被蓋住 | 中心與四角內縮 2px 做 `elementFromPoint`；中心被蓋＝點不到（嚴重度 1），只有角落被鄰居吃掉＝嚴重度 2 | 圓角／膠囊形改測內縮 30% 的點；折行的行內連結只看第一行；輸入框裡的清除鈕、被固定列蓋住但可捲出來的內容不算 |
| R2 | 可點的東西互相重疊 | 互不包含的兩個可點元素，可見外框重疊面積 > 0（兩邊都 > 0.5px） | label 與 input、輸入框內的清除鈕、固定列下可捲動的內容不算 |
| R3 | 文字被截斷 | overflow 為 hidden／clip、內容比框大超過 1px、有文字 | `ellipsis`、`line-clamp`、可捲、收合（尺寸 0）、編輯器與白板畫布不算 |
| R4 | 捲動容器的最後一項到不到／子項被壓縮 | 捲到底後最後一項要在框內（且不在畫在它上面的固定列下）；子項在正常流裡的內容比自己的框多 > 1.5px 也報 | 絕對定位的內容（例如撐大點擊範圍的 `::after`）不算；第一版用 `scrollHeight` 會把它算進去，已改 |
| R5 | 滑鼠移過去版面位移 | 桌面（1280、1100、1920）對最多 30 個可點元素 hover，任何可見元素位移或改大小 > 0.5px | 只報最外層位移的元素；hover 才出現的新元素不算 |
| R6 | 橫向捲軸 | document 的 scrollWidth 大於視窗寬度 | 被祖先裁掉的元素不算 |
| R7 | 手機點擊目標 ≥ 44×44 | 沿元素中心的橫線與直線用 `elementFromPoint` 量實際可點長度（含 `::after`） | 編輯器／內文的行內連結、有 label 的 checkbox、白板畫布裡隨縮放變小的卡片內容不算 |
| R8 | 同層對齊 | 同層級項目的文字起點、月曆同欄格子的中線、同列格子的上緣 | 少於 3 項或沒有「多數」不報；月曆第一版比左緣，表頭與日期圓圈寬度不同會誤報，改比中線 |
| R9 | 手機點過不留 hover 色 | 點列表項、等 450ms、再點空白處，兩個時間點的背景色都要等於點之前 | 名稱含刪除／登出／新增等的按鈕不點（審核不能改資料）；點了就離開畫面的略過 |

**本輪沒有違規的規則：** R2（互相重疊）、R6（橫向捲軸）、R8（對齊）、R9（手機 hover 殘留）。R2 早期版本報過 3 筆，全是誤報（捲動內容被固定的底部導覽列壓著、搜尋框裡的清除鈕），已排除；R9 在 selftest 的壞例子上會報，在 app 上沒有報（`@media (hover: hover)` 的包法目前是對的）；R8 一度在日記的月曆上報了 3.7px；看截圖，表頭與日期在視覺上是對齊的（格子寬度不同、中線一致），判斷是規則的誤報，改成比中線後不再報。

### 規則的驗證（規則會抓到真的問題嗎）

1. **假頁面（`selftest.mjs`，20 個案例全過）**：每條規則一個該報的壞例子、一個不該報的好例子；壞例子照業主回報的五類問題做：箭頭被直條蓋住、底部面板最後一項被 flex 壓縮與被底部導覽列蓋住、hover 時標題下一行換行把內文推下去、手機 hover 色殘留、橫向捲軸、小按鈕、截斷、不齊。
2. **修正前的真實版本**：把 `01f47f56^1`（#1178 合併前，三個修正都還沒有）建成瀏覽器版，用同一套規則：
   - **#1178（手機 ⋯ 面板最後一項被壓縮）：R4 抓到**——`div.note-sheet-group`「子項被壓縮：內容比框多出 28px（框高 260px）」（Pixel 5、note-more-menu）；現在的 main 上 0 筆。
   - **#1182（hover 時標題下那一行與內文跳動）：R5 抓到**——游標移到「只有我」晶片時，「剛剛修改」上移 6px、內文區上移 12px（1280×800）；現在的 main 上 0 筆。
   - **#1179（選取列的展開箭頭被左側直條蓋住）：R1 抓不到。** 那條直條是列的邊框／偽元素（裝飾），不吃點擊，`elementFromPoint` 看到的仍是箭頭按鈕；這是用「點得到」量位置的盲點，不是規則調得不夠。建議之後另做一條「可點元素緊貼容器邊框／陰影（< 2px）」的規則（R10），列入建議批次的後續。

   | 修正前（01f47f56^1）R4：⋯ 面板 | 修正前 R5：hover 位移 |
   |---|---|
   | （截圖未隨公開庫附上：fix1178-before-R4-note-more-menu-pixel5.png） | （截圖未隨公開庫附上：fix1182-before-R5-tree-expanded-1280.png） |

## 畫面與寬度

寬度：桌面 1280×800、1440×900、1920×1080，窄桌面 1100×800，平板 900×1200（app 在這個寬度用手機版面），手機 Pixel 5，1440×900 深色。畫面（固定資料：長內文含標籤、子筆記、長標題）：

| 畫面 id | 說明 |
|---|---|
| `note-long` | 筆記：長內文、有標籤 |
| `note-children` | 筆記：有子筆記 |
| `note-more-menu` | 筆記：⋯ 選單／手機底部面板 |
| `note-new-view-menu` | 筆記：⋯ 選單裡的「新增檢視」 |
| `info-features` | 資訊欄：功能分頁 |
| `info-tags` | 資訊欄：標籤分頁 |
| `info-relations` | 資訊欄：關係分頁 |
| `tree-expanded` | 側欄筆記樹：展開、選取、長標題 |
| `tree-selected-parent` | 側欄筆記樹：選取有子筆記的那一列（展開箭頭） |
| `tags-list` | 標籤頁（列表） |
| `tags-table` | 標籤頁（表格檢視） |
| `daily` | 日記／今天 |
| `daily-date-picker` | 日期選擇器／月曆 |
| `tasks` | 任務 |
| `inbox` | 收件匣 |
| `search-sidebar` | 搜尋（側欄） |
| `search-palette` | 搜尋（指令面板） |
| `settings` | 設定 |
| `settings-more` | 設定（其他分頁） |
| `canvas` | 白板 |
| `slides` | 簡報檢視 |
| `history` | 歷史 |
| `create-panel` | 建立面板（＋） |

**沒有做的畫面：** 關係圖與複習（`?view=graph`、`?view=review`）打得開，但不在業主指定的清單，為了縮短時間（全部跑完約 11 分鐘）沒放進；瀏覽器版沒有的功能（上傳、備份還原、AI、發布網站、外部行事曆）自然也沒有。

## 每個畫面 × 寬度的結果（違規筆數）

| 畫面 | 1280 | 1440 | 1920 | 1100 | 900 | Pixel 5 | 1440 深色 |
|---|---|---|---|---|---|---|---|
| `note-long` | ✓ | ✓ | ✓ | ✓ | ✓ | 3 | ✓ |
| `note-children` | 1 | 1 | 1 | 1 | 1 | 7 | 1 |
| `note-more-menu` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `note-new-view-menu` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `info-features` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `info-tags` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `info-relations` | ✓ | ✓ | ✓ | ✓ | ✓ | 3 | ✓ |
| `tree-expanded` | ✓ | ✓ | ✓ | ✓ | 4 | 13 | ✓ |
| `tree-selected-parent` | 1 | 1 | 1 | 1 | 4 | 12 | 1 |
| `tags-list` | ✓ | ✓ | ✓ | ✓ | ✓ | 2 | ✓ |
| `tags-table` | ✓ | ✓ | ✓ | ✓ | ✓ | 2 | ✓ |
| `daily` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `daily-date-picker` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `tasks` | ✓ | ✓ | ✓ | ✓ | ✓ | 2 | ✓ |
| `inbox` | ✓ | ✓ | ✓ | ✓ | ✓ | 2 | ✓ |
| `search-sidebar` | ✓ | ✓ | ✓ | ✓ | ✓ | 3 | ✓ |
| `search-palette` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `settings` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `settings-more` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `canvas` | 1 | ✓ | 1 | 1 | ✓ | 10 | ✓ |
| `slides` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `history` | ✓ | ✓ | ✓ | ✓ | ✓ | 1 | ✓ |
| `create-panel` | ✓ | ✓ | ✓ | ✓ | ✓ | 6 | ✓ |
| **合計** | **3** | **2** | **3** | **3** | **9** | **75** | **2** |

✓＝該畫面該寬度沒有違規。R5 只在 1280、1100、1920 跑；R7、R9 只在 Pixel 5 跑。

各規則違規筆數：R1＝33、R2＝0、R3＝1、R4＝0、R5＝3、R6＝0、R7＝60、R8＝0、R9＝0。

## 違規（依嚴重度排序）

嚴重度：1＝使用者看得到的壞掉；2＝不好點／會跳動；3＝差 1–2px。每筆的完整清單（元素選擇器、寬度）在 `baseline.json`。「批次」對應下一節。

| # | 嚴重度 | 規則 | 問題 | 出現在 | 筆數 |
|---|---|---|---|---|---|
| L1 | 1 | R7 | 白板（手機）選取卡片的工具列：「開啟」按鈕被壓成 3.6px 寬 | canvas（Pixel 5） | 1 |
| L2 | 1 | R3 | 手機設定首頁的清單卡片底部被裁掉 3px | settings（Pixel 5） | 1 |
| M1 | 2 | R1 | 關係區「子筆記」列表：相鄰兩列的點擊範圍互相蓋住 2px（所有寬度） | note-children（1280、1440、1920、1100、900、Pixel 5、1440 深色）；tree-selected-parent（1280、1440、1920、1100、1440 深色） | 12 |
| M2 | 2 | R1 | 手機側欄筆記樹：展開箭頭按鈕的點擊範圍蓋住旁邊的標題按鈕 | tree-expanded（900、Pixel 5）；tree-selected-parent（900、Pixel 5） | 8 |
| M3 | 2 | R1 | 手機側欄標題列：搜尋、建立、更多三個圖示按鈕的點擊範圍互相蓋到角落 | tree-expanded（900、Pixel 5）；tree-selected-parent（900、Pixel 5） | 8 |
| M4 | 2 | R1 | 手機標題下的標籤列：「加上標籤」的點擊範圍蓋住前一個標籤的右緣 | note-long（Pixel 5）；note-children（Pixel 5） | 2 |
| M5 | 2 | R1 | 資訊欄（手機）「連結」列表：相鄰兩列的點擊範圍互相蓋到角落 | info-relations（Pixel 5） | 1 |
| M6 | 2 | R1 | 白板（手機）選取卡片的工具列：相鄰按鈕的點擊範圍互相蓋到角落 | canvas（Pixel 5） | 2 |
| M7 | 2 | R5 | 白板卡片：滑鼠移到卡片上時，標題輸入框從 227px 縮成 205px | canvas（1280、1920、1100） | 3 |
| T1 | 2 | R7 | 手機資訊欄：分頁按鈕（功能／標籤／關係）可點高度 41px、「連結」列表每列 25px | info-features（Pixel 5）；info-tags（Pixel 5）；info-relations（Pixel 5）；slides（Pixel 5） | 5 |
| T2 | 2 | R7 | 圖示按鈕可點寬度約 33–41px（側欄標題列、標籤頁標題動作、建立面板、白板縮放與工具列、⋯ 與資訊鈕） | tree-expanded（Pixel 5）；tree-selected-parent（Pixel 5）；tags-list（Pixel 5）；canvas（Pixel 5）；create-panel（Pixel 5） | 19 |
| T3 | 2 | R7 | 手機側欄筆記樹每列可點高度約 40–43px | tree-expanded（Pixel 5）；tree-selected-parent（Pixel 5）；search-sidebar（Pixel 5） | 13 |
| T4 | 2 | R7 | 手機列表與小按鈕：子筆記列 40px、「更多」32px、表格標題 21px、天數切換 29px、「記一筆」35px | note-children（Pixel 5）；tags-table（Pixel 5）；tasks（Pixel 5）；inbox（Pixel 5） | 6 |
| T5 | 2 | R7 | 手機上的小目標：「只有我」晶片 17px、筆記標題輸入框 28px、⋯ 選單的「刪除」24px、字級滑桿 37px、連結 27px、標籤名稱 29px 寬 | note-long（Pixel 5）；note-children（Pixel 5）；note-more-menu（Pixel 5）；note-new-view-menu（Pixel 5）；settings-more（Pixel 5）；history（Pixel 5） | 9 |
| T6 | 3 | R7 | 手機標題列的帳號按鈕可點區域 43×44（差 1px） | tree-expanded（Pixel 5）；tree-selected-parent（Pixel 5）；daily（Pixel 5）；daily-date-picker（Pixel 5）；tasks（Pixel 5）；inbox（Pixel 5）；search-sidebar（Pixel 5） | 7 |

### L1（嚴重度 1，R7）白板（手機）選取卡片的工具列：「開啟」按鈕被壓成 3.6px 寬

- 出現在：canvas（Pixel 5）
- 量到：`{"clickable": "0×0", "drawn": "3.6×23"}`
- 判斷的原因：`.board-selection-bar` 是 flex 容器、`overflow-x: auto`，但按鈕仍可縮（flex-shrink 預設 1），放不下時 `開啟` 被壓到 3.6×23px（可點區域 0×0），手指點不到，也不會捲。
- 位置：`packages/frontend/src/components/BoardSelectionBar.css`
- 建議：`.board-selection-bar .ui-btn { flex: none }`，讓溢出變成橫向捲動而不是壓縮按鈕。（批次 E）

### L2（嚴重度 1，R3）手機設定首頁的清單卡片底部被裁掉 3px

- 出現在：settings（Pixel 5）
- 量到：`{"overflowX": "-", "overflowY": "3px", "client": "359×61", "scroll": "359×64"}`
- 判斷的原因：`.settings-list` 為了圓角設了 `overflow: hidden`，內容比框高 3px（`clientHeight` 61、`scrollHeight` 64），底部 3px 被切；多出來的是什麼（最後一列的邊框或間距）沒有確認。
- 位置：`packages/frontend/src/settings/SettingsModal.css`（`.settings-list`）
- 建議：卡片不要固定高度，或移掉多出來的 3px（多半是最後一列的下邊框／間距）。（批次 F）

  （截圖未隨公開庫附上：L2）

### M1（嚴重度 2，R1）關係區「子筆記」列表：相鄰兩列的點擊範圍互相蓋住 2px（所有寬度）

- 出現在：note-children（1280、1440、1920、1100、900、Pixel 5、1440 深色）；tree-selected-parent（1280、1440、1920、1100、1440 深色）
- 量到：`{"coveredPoints": "2/5", "coveredBy": …子筆記乙：標題很長很長很長很長很長很長很長很長很長很長很\"", "centreCovered": false}`
- 判斷的原因：按鈕 `min-height: 40px`，但 `::after` 把點擊範圍撐到 `max(100%, 44px)`，上下各多出 2px，蓋到相鄰列。
- 位置：`packages/frontend/src/components/MemberList.css`（`.tag-member-list--flat button`）
- 建議：把列高改成 44px（`min-height: var(--onden-tap, 44px)`）並拿掉 `::after`，或讓 `::after` 不超過列高。（批次 A）

  （截圖未隨公開庫附上：M1）

### M2（嚴重度 2，R1）手機側欄筆記樹：展開箭頭按鈕的點擊範圍蓋住旁邊的標題按鈕

- 出現在：tree-expanded（900、Pixel 5）；tree-selected-parent（900、Pixel 5）
- 量到：`{"coveredPoints": "2/5", "coveredBy": …▾\"", "centreCovered": false}`
- 判斷的原因：箭頭按鈕擴大點擊範圍（`::after`），向右蓋到標題按鈕的左側角落。
- 位置：`packages/frontend/src/components/OverviewSidebar.css`（`.obsidian-group-toggle`、`.obsidian-group-title`）
- 建議：箭頭與標題各自有不重疊的 44px 範圍（標題按鈕 `padding-left` 讓出箭頭的寬度）。（批次 B）

  （截圖未隨公開庫附上：M2）

### M3（嚴重度 2，R1）手機側欄標題列：搜尋、建立、更多三個圖示按鈕的點擊範圍互相蓋到角落

- 出現在：tree-expanded（900、Pixel 5）；tree-selected-parent（900、Pixel 5）
- 量到：`{"coveredPoints": "2/5", "coveredBy": …建立\"] \"建立\"", "centreCovered": false}`
- 判斷的原因：三個 32px 的圖示按鈕各自擴大到 44px，間距小於擴大的量。
- 位置：`packages/frontend/src/components/OverviewSidebar.css、styles/global.css`（`.sb-bar-btn`）
- 建議：按鈕間距 ≥ 12px，或把外框改成 44px 並拿掉 `::after`。（批次 B）

  （截圖未隨公開庫附上：M3）

### M4（嚴重度 2，R1）手機標題下的標籤列：「加上標籤」的點擊範圍蓋住前一個標籤的右緣

- 出現在：note-long（Pixel 5）；note-children（Pixel 5）
- 量到：`{"coveredPoints": "2/5", "coveredBy": …關於這篇筆記\"] > div.note-meta-line > div.obsidian-prop-strip.title-tag-row[aria-label=\"筆記標籤\"] > button.prop-tag.prop-tag--add[aria-label=\"加上標籤\"] \"加上標籤\"", "centreCovered": false}`
- 判斷的原因：「＋」按鈕的 `::after` 往左延伸，蓋到緊鄰標籤的右側角落；點標籤右緣會誤開「加上標籤」。
- 位置：`packages/frontend/src/components/OverviewEditor.css`（`.prop-tag--add`、`.prop-tag-name`）
- 建議：標籤列的間距 ≥ 擴大量，或擴大只往不會碰到鄰居的方向。（批次 C）

  （截圖未隨公開庫附上：M4）

### M5（嚴重度 2，R1）資訊欄（手機）「連結」列表：相鄰兩列的點擊範圍互相蓋到角落

- 出現在：info-relations（Pixel 5）
- 量到：`{"coveredPoints": "2/5", "coveredBy": …有子筆記的父筆記被連結\"", "centreCovered": false}`
- 判斷的原因：列高 25px 的小按鈕各自擴大到 44px，互相重疊。
- 位置：`packages/frontend/src/components/InfoTagsTab.css`（`.links-relation-list`）
- 建議：列高改 44px。（批次 D）

  （截圖未隨公開庫附上：M5）

### M6（嚴重度 2，R1）白板（手機）選取卡片的工具列：相鄰按鈕的點擊範圍互相蓋到角落

- 出現在：canvas（Pixel 5）
- 量到：`{"coveredPoints": "2/5", "coveredBy": …選取的卡片\"] > button.ui-btn.ui-btn--ghost.ui-btn--sm[aria-label=\"以此為中心\"] \"以此為中心\"", "centreCovered": false}`
- 判斷的原因：按鈕 37×23px 各自擴大到 44px，相鄰重疊。
- 位置：`packages/frontend/src/components/BoardSelectionBar.css`
- 建議：同 L1：工具列改成換行／捲動並給按鈕 44px 高。（批次 E）

  （截圖未隨公開庫附上：M6）

### M7（嚴重度 2，R5）白板卡片：滑鼠移到卡片上時，標題輸入框從 227px 縮成 205px

- 出現在：canvas（1280、1920、1100）
- 量到：`{"whenHovering": …\"", "before": "919.6,173.9 346.9×28.9", "after": "919.6,173.9 313.5×28.9"}`
- 判斷的原因：`.card-node-title-input` 是 `flex: 1 1 auto`，hover 時標題列裡有元素出現並佔位，把它擠窄 22px（推測是 hover 才顯示的按鈕；沒有逐一確認是哪個元素）。
- 位置：`packages/frontend/src/components/CardNode.css`（`.card-node-header`、`.card-node-title-input`）
- 建議：hover 才出現的元素預留固定寬度（`visibility` 而不是 `display`），或絕對定位浮在標題上。（批次 E）

  （截圖未隨公開庫附上：M7）

### T1（嚴重度 2，R7）手機資訊欄：分頁按鈕（功能／標籤／關係）可點高度 41px、「連結」列表每列 25px

- 出現在：info-features（Pixel 5）；info-tags（Pixel 5）；info-relations（Pixel 5）；slides（Pixel 5）
- 量到：`{"clickable": "44×41", "drawn": "26×35.5"}`
- 判斷的原因：分頁按鈕 26×35.5px，`::after` 擴大後仍只有 41px 高；連結列表每列只有 25px 高。
- 位置：`packages/frontend/src/components/InfoTagsTab.css`（`.info-panel-tab`）
- 建議：分頁按鈕與列表列 `min-height: 44px`。（批次 D）

  （截圖未隨公開庫附上：T1）

### T2（嚴重度 2，R7）圖示按鈕可點寬度約 33–41px（側欄標題列、標籤頁標題動作、建立面板、白板縮放與工具列、⋯ 與資訊鈕）

- 出現在：tree-expanded（Pixel 5）；tree-selected-parent（Pixel 5）；tags-list（Pixel 5）；canvas（Pixel 5）；create-panel（Pixel 5）
- 量到：`{"clickable": "35×44", "drawn": "32×32"}`
- 判斷的原因：32–40px 的圖示按鈕在手機沒有擴到 44px。
- 位置：`packages/frontend/src/components/OverviewSidebar.css、components/SchemaLens.css、modules/capture/QuickCapture.css、components/ui`（icon 按鈕）
- 建議：圖示按鈕在手機統一用 `--onden-tap`（44px）；`components/ui` 的 icon 按鈕一處改，各處受惠。（批次 B）

  （截圖未隨公開庫附上：T2）

### T3（嚴重度 2，R7）手機側欄筆記樹每列可點高度約 40–43px

- 出現在：tree-expanded（Pixel 5）；tree-selected-parent（Pixel 5）；search-sidebar（Pixel 5）
- 量到：`{"clickable": "44×43", "drawn": "367×40"}`
- 判斷的原因：列高 40px，擴大點擊範圍被相鄰列吃掉 1–3px。
- 位置：`packages/frontend/src/components/OverviewSidebar.css、components/ObsidianImport.css`（`.obsidian-page-button`）
- 建議：手機列高 44px。（批次 B）

  （截圖未隨公開庫附上：T3）

### T4（嚴重度 2，R7）手機列表與小按鈕：子筆記列 40px、「更多」32px、表格標題 21px、天數切換 29px、「記一筆」35px

- 出現在：note-children（Pixel 5）；tags-table（Pixel 5）；tasks（Pixel 5）；inbox（Pixel 5）
- 量到：`{"clickable": "44×40", "drawn": "353×40"}`
- 判斷的原因：各自的 `min-height` 小於 44px。
- 位置：`packages/frontend/src/components/MemberList.css、components/NoteRelations.css、components/collections/CollectionView.css、modules/daily/day/day.css`
- 建議：依元件把手機的最小高度設成 44px。（批次 A）

  （截圖未隨公開庫附上：T4）

### T5（嚴重度 2，R7）手機上的小目標：「只有我」晶片 17px、筆記標題輸入框 28px、⋯ 選單的「刪除」24px、字級滑桿 37px、連結 27px、標籤名稱 29px 寬

- 出現在：note-long（Pixel 5）；note-children（Pixel 5）；note-more-menu（Pixel 5）；note-new-view-menu（Pixel 5）；settings-more（Pixel 5）；history（Pixel 5）
- 量到：`{"clickable": "44×28", "drawn": "353×32.5"}`
- 判斷的原因：元件在手機沒有把可點區域撐到 44px。
- 位置：`packages/frontend/src/components/OverviewEditor.css、components/ui`（menu item）、settings/SettingsModal.css
- 建議：晶片與選單項目手機用 44px 高；標題輸入框保留（整列可點）。（批次 C）

  （截圖未隨公開庫附上：T5）

### T6（嚴重度 3，R7）手機標題列的帳號按鈕可點區域 43×44（差 1px）

- 出現在：tree-expanded（Pixel 5）；tree-selected-parent（Pixel 5）；daily（Pixel 5）；daily-date-picker（Pixel 5）；tasks（Pixel 5）；inbox（Pixel 5）；search-sidebar（Pixel 5）
- 量到：`{"clickable": "43×44", "drawn": "28×28"}`
- 判斷的原因：28px 的頭像擴大到 43px 寬。
- 位置：`packages/frontend/src/components/AppTopbar.css`（`.user-chip`）
- 建議：擴大量 +1px。（批次 B）

  （截圖未隨公開庫附上：T6）

## 建議的修正批次（依檔案／元件分組，方便派工）

每批的完成條件：`npm run layout:audit` 裡對應的違規從 `baseline.json` 刪掉，且沒有新違規。

- **批次 A：關係區與列表的手機列高**——檔案：`components/MemberList.css`、`components/NoteRelations.css`、`components/collections/CollectionView.css`、`modules/daily/day/day.css`、`components/EmptyState`。內容：M1、T4（含 R7 的 tag-member-list、更多、表格標題、天數切換、「記一筆」）。先改 `MemberList.css` 的 40px＋44px `::after`，這一個改動解掉 M1 全寬度的 R1 與手機的 R7。
- **批次 B：手機側欄（筆記樹與標題列）**——檔案：`components/OverviewSidebar.css`、`components/ObsidianImport.css`、`styles/global.css`（`.sb-bar-btn`）、`components/AppTopbar.css`。內容：M2、M3、T2 的側欄部分、T3、T6：列高 44px、圖示按鈕間距、展開箭頭與標題的點擊範圍分開；`user-chip` 加 1px。
- **批次 C：標籤列與筆記標頭**——檔案：`components/OverviewEditor.css`。內容：M4、T5 的晶片：標籤列間距與「只有我」晶片手機高度。
- **批次 D：資訊欄**——檔案：`components/InfoTagsTab.css`。內容：M5、T1：分頁按鈕與連結列表手機 44px 高。
- **批次 E：白板（手機）**——檔案：`components/CardNode.css`、`components/BoardSelectionBar.css`、白板縮放控制。內容：L1、M6、M7、T2 的白板部分：選取工具列換行或捲動（L1 最優先，按鈕被壓成 3.6px）、卡片標題 hover 不改寬度。
- **批次 F：設定（手機）**——檔案：`settings/SettingsModal.css`。內容：L2：清單卡片裁掉 3px；T5 的字級滑桿 37px。
- **批次 G：建立面板、圖示按鈕（共用）**——檔案：`modules/capture/QuickCapture.css`、`components/ui`（icon 按鈕、menu item）。內容：T2 的建立面板與共用元件、T5 的 ⋯ 選單「刪除」24px：改共用元件一處，各處受惠。
- **批次 H（工具）：** 新增 R10「可點元素緊貼容器邊框／陰影」以涵蓋 #1179 這類裝飾蓋住的問題；把 `layout:audit` 加進擁有者指定的 CI；補 WebKit。

建議順序：E（L1 是唯一「點不到」的）→ A（一處改動解掉最多筆）→ B（手機側欄是每天用的）→ D、C、F、G。

## 沒有驗證到的

- 只有 Chromium：桌面寬度是調整視窗；手機是 Playwright 的 Pixel 5 模擬（觸控、DPR 2.75），**不是真機**。WebKit／iOS 沒跑（雲端裝不了 WebKit，見 `docs/architecture/browser-app.md` §10）。
- 規則只量位置與可點範圍；顏色對比、字級、動畫過程中的版面沒有檢查。畫面「看起來對不對」仍要人看。
- 畫面的內容是固定資料；很長的標題、很多標籤、很多子筆記以外的情況（空狀態、錯誤狀態）只涵蓋 `inbox`（空）。
- app 的時間來自 Worker 的系統時鐘，無法從外面凍結；日期相關畫面的內容隨執行日變，所以基準的比對鍵不含文字。
