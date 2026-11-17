# 段落錨點批 3：`^id` 拔除的盤點與切換設計

> 狀態：歷史紀錄（寫於 2026-11-07，最後更新 2026-11-08，分支 `feat/block-anchors-batch3`）；切換與收尾項目已實作並測試，完成度以 PR #1334 說明為準。
> 上位文件：[block-anchors-2026-11-01.md](block-anchors-2026-11-01.md)（§0.5、§11、§12）。

## 已做與未做

| 項目 | 狀態 |
| --- | --- |
| 在帶 `{…}` 的段落行尾按 Enter 開新段落（鍵盤與觸控 beforeinput；組字中不動文字） | 已做、已測（jsdom；真機輸入法未驗證） |
| 已壞資料接回：`文字 {複習} ^id\n下一行` 的標記搬回段落最後一行，同一個 id、同一列、不改最近更新順序 | 已做、已測（PGlite）；系統工作 `block-marker-repair`，開機 1 分鐘後與每 6 小時各跑一次，冪等 |
| 後端：存檔／建立／任務放置／@AI／收回原文不再寫 `^id`，區塊身分走錨點；遷移 180；逐篇轉換與反向回退；最低客戶端閘門（426 `client_too_old`）；歷史把系統整理收成一列；發布與備份還原帶錨點 | 已做、已測（PGlite） |
| 前端改讀錨點、剪貼帶錨點、編輯器不再隱藏／保護 `^id` | 已做、已測（見 PR 說明） |
| 搬成子筆記帶走範圍內的錨點與區塊列、復原接回、獨立出去復原回原列 | 已做、已測（PGlite；2026-11-08） |
| `[[筆記#^id]]` 改寫成 `[[筆記/開頭]]`＋綁定（同一個系統工作，冪等，回退可還原；不確定的列進報告） | 已做、已測（PGlite） |
| 單篇匯出三種段落連結寫法（預設／腳註／Obsidian 相容）、Markdown zip 寫行尾 `^id` 且匯入讀回、roundTripCompare 比對 block refs | 已做、已測（PGlite、jsdom） |
| 歷史「系統整理」一列的前端畫面 | 已做、已測（jsdom） |
| RSS 摘錄接錨點（伺服器替摘錄建錨點；匯出展開 `![[筆記/開頭]]` 的摘錄） | 已做、已測；RSS 面板自己寫出的 `![[筆記/開頭]]` 嵌入尚未綁定（讀法靠開頭文字，與手打的連結相同） |
| 真機輸入法（Android 注音）、正式資料副本演練、筆電真 Postgres | 未驗證（留給驗收者） |

## 切換設計（盤點得出的決定，未實作）

1. **`block_nodes.block_ref` 等於錨點 id**：這樣 `tasksStore`、`review`、`blockCitations`、備份等把 `block_ref` 當不透明 id 的程式（盤點表 N 類）不用改；
   只有「在正文裡用 `^id` 找區塊」的 L 類改成「錨點 span.from 等於區塊起點」。
2. **遷移保留舊 id**：每個行尾／自成一行／`> ^id` 轉成錨點時沿用同一個 id（工作區內唯一；撞號者換新 id 並改寫同批連結），
   已存在但 id 不同的 `block_nodes.anchor_id` 以改名對齊 `block_ref`（`block_anchors` 沒有外鍵，要同步改 `block_nodes.anchor_id`、`block_link_bindings.anchor_id`、`agent_sessions.anchor_block_id`）。
   舊 `[[筆記#^id]]` 因此仍解析得到，再逐篇改寫成 `[[筆記/開頭]]`＋綁定。
3. **同步順序顛倒**：`applyBodyChange` 現在先 `syncBlockNodes`（讀正文 `^id`）再搬錨點再 `linkBlockNodeAnchors`；切換後改為先搬錨點，再讓 `syncBlockNodes`
   以錨點決定每個帶 `{…}` 區塊的 ref（沒有錨點就 `insertAnchor`），`linkBlockNodeAnchors` 併入。
4. **錨點是 `maybe`／`lost` 的帶標籤區塊**：不替它另建列（避免複習卡重複），列保留在「找不到的段落」。
5. 遷移工作用 `systemJobs` 的系統工作逐篇走 `updateNode`（本批已讓 `updateNode` 接受系統工作者、`keepUpdatedAt` 不動最近更新；`applyBodyChange` 對系統工作者不排屬性衍生）。

## 盤點表（`git grep` 的 87 個檔案與其他寫法）

W＝寫入（切換時必須停寫）、L＝定位（改查錨點）、M＝只留給遷移與匯入讀舊資料、N＝不用改、T＝測試或 fixture 要改寫、D＝文件或產生檔。
下表由唯讀盤點產生，逐檔開過相關行；`*` 是原 87 檔以外補查到的。


說明：`*` = 不在原 87 檔清單內、由 `newBlockId|#\^|writeBlockIds|blockAnchors|idAt` 補查到的檔案。
`[[Note#^id]]` / `![[Note#^id]]` 連結文字依 S0.5 也會被 `[[筆記/段落]]` 取代：只讀它的歸 L，會組出它的歸 W（理由欄註明「連結」）。

### 1. packages/markdown/src（非測試）
| file | cat | 理由 |
|---|---|---|
| packages/markdown/src/blocks.ts | W | assignBlockIds 補寫 ` ^id`／改名重複 id；parseBlocks/blockAnchors/existingIds 另屬 L |
| packages/markdown/src/blockChild.ts | W | planBlockExpand 把 ` ^ref` 寫回內文；planBlockMove 用 parseBlocks ref 定位（L） |
| packages/markdown/src/excerpt.ts | W | excerptBlock 結尾寫 `> ^id`；parseExcerpts 用 blockAnchors 讀（L） |
| packages/markdown/src/blockId.ts | L | `^id` 文法、trailingBlockId、withoutLineTrailers；newBlockId 供寫入端用 |
| packages/markdown/src/blockCard.ts | L | blockCardSides 以 parseBlocks().ref 找段落、剪掉 marks.ref |
| packages/markdown/src/blockRef.ts | L | noteHasBlock 以 `^id` 字串加 blockAnchors 判斷 |
| packages/markdown/src/blockHome.ts* | L | 後援選擇用 blockAnchors(page.markdown) 找 id |
| packages/markdown/src/blockLink.ts* | L | 舊 `[[筆記#^id]]` 連結讀取（連結） |
| packages/markdown/src/blockCitations.ts* | L | 掃 `#^id` 連結算被引用（連結） |
| packages/markdown/src/embedExtract.ts* | L | extractBlock/embedEditable 用 blockAnchors 找 id |
| packages/markdown/src/embeds.ts* | L | parseEmbed 以 `#^id` regex 取 blockId（連結） |
| packages/markdown/src/linkTargets.ts | L | ref 取自 ids map 或 trailingBlockId；標籤文字剝 id |
| packages/markdown/src/mentions.ts | L | parseBlock 以 trailingBlockId 取提及的 blockId/idAt |
| packages/markdown/src/paragraphs.ts | L | splitParagraphs 用 trailingBlockId 讀 blockId、`^id` 獨立行 |
| packages/markdown/src/remarkBlockId.ts | L | 渲染時由 treeMarks 讀 `^id`、設 data-block-id 並隱藏 |
| packages/markdown/src/index.ts | L | 匯出 trailingBlockId、管線掛 remarkBlockId、`#^id` 連結 regex |
| packages/markdown/src/sitePath.ts* | L | 站台連結標籤認 `#^` 片段（連結） |
| packages/markdown/src/callouts.ts | N | 僅註解提到 data-block-id |
| packages/markdown/src/headingAnchors.ts | N | 僅註解提到 remarkBlockId 順序 |
| packages/markdown/src/parsers.ts | N | 僅表格註解 |
| packages/markdown/src/sanitizeSchema.ts | N | 僅註解（放行 data-block-id 屬性） |
| packages/markdown/src/attributeKey.ts*, frontmatter.ts*, mediaRefs.ts*, slug.ts*, uuid.ts* | N | `^${…}` 為無關 regex |

### 2. packages/markdown（測試／fixture／生成）
| file | cat | 理由 |
|---|---|---|
| packages/markdown/src/blockAnchors.test.ts | T | 各區塊種類 `^id` 錨定與渲染隱藏 |
| packages/markdown/src/blockChild.test.ts* | T | 搬出／展開段落（含 `^b1`）與連結改寫 |
| packages/markdown/src/blockRef.test.ts* | T | noteHasBlock 對 `^k1` |
| packages/markdown/src/blockTagSlot.test.ts | T | addBlockTag 與 parseBlocks 讀回 |
| packages/markdown/src/blockTagsRender.test.ts | T | `{a,b} ^id` 兩個記號被隱藏 |
| packages/markdown/src/blocks.test.ts | T | assignBlockIds／parseBlocks／existingIds 行為 |
| packages/markdown/src/excerpt.test.ts | T | 摘錄 `> ^ab1` 往返 |
| packages/markdown/src/fixtures/blockAnchors.json | T | 各區塊含 `^id` 的共用 parity fixture |
| packages/markdown/src/fixtures/wikilinkTargets.json* | T | `#^block id` 連結目標案例 |
| packages/markdown/src/embeds.test.ts* | T | parseEmbed `#^id`（連結） |
| packages/markdown/src/headingAnchors.test.ts* | T | 標題文字去掉 `{…}` 與 `^id` |
| packages/markdown/src/linkContext.test.ts* | T | 含 `^abc`、`[[目標#^k1]]` 的上下文 |
| packages/markdown/src/paragraphs.test.ts* | T | splitParagraphs 的 `^id` 文法 |
| packages/markdown/src/plainText.test.ts* | T | plainInline 剝 `#^abc`（連結） |
| packages/markdown/src/sitePath.test.ts* | T | servedLinkTarget `#^x1` |
| packages/markdown/src/text.test.ts* | T | wikilinkTarget("#^block") |
| packages/markdown/src/test/blockCitations.test.ts* | T | `[[Alpha#^p1]]` 被引用計數 |
| packages/markdown/src/test/blocksAndCodecs.fuzz.test.ts | T | parseBlocks/assignBlockIds 模糊測試 |
| packages/markdown/src/test/fuzz-corpus/markdown.json* | T | 語料含 `^id`、`[[a#^id]]` |
| packages/markdown/src/test/guards/dup-b2-constants.guard.test.ts* | T | 守門：newBlockId 唯一擁有者 |
| packages/markdown/src/test/orphanBlockIds.test.ts | T | 孤兒 `^id` 與 assignBlockIds |
| packages/markdown/src/test/properties/blockIds.property.test.ts | T | `^id` 解析／指派的性質測試 |
| packages/markdown/src/test/properties/wikilinks.property.test.ts* | T | 隨機 `Note#^id` 連結 |
| packages/markdown/contract/api-shapes.json | D | 生成的 API 形狀（block_ref: null） |
| packages/markdown/src/pipeline.test.ts*, searchQuery.test.ts*, word.test.ts* | N | `e^{i}`、脚註、regex 跳脫，無關 |

### 3. packages/contract
| file | cat | 理由 |
|---|---|---|
| packages/contract/src/blocks.ts | N | BlockCitationRow.block_ref 當不透明 id |

### 4. packages/backend src
| file | cat | 理由 |
|---|---|---|
| packages/backend/src/services/blockNodes.ts | W | withBlockIds 呼叫 assignBlockIds 補 `^id`；syncBlockNodes/taskLineTitle 另屬 L |
| packages/backend/src/services/nodeUpdate.ts | W | updateNode 在 addBlockIds 時呼叫 withBlockIds |
| packages/backend/src/services/noteCreate.ts | W | createNote 呼叫 withBlockIds |
| packages/backend/src/services/aiSuggestions.ts | W | 接受建議時 writeBlockIds:true，補回舊 id |
| packages/backend/src/services/agentTools/updateNode.ts* | W | agent 工具存檔 writeBlockIds:true |
| packages/backend/src/services/aiSuggestionBlocks.ts | W | keepingBlockId 把舊 `^id` 接回 AI 改寫文字 |
| packages/backend/src/services/agentSessions.ts | W | createSession 補 ` ^id`；replyBlock/hasBlockId/withReplyBlock 寫與找 `  ^id`（L） |
| packages/backend/src/modules/tasks/placement.ts | W | placeTask 組 `{task} ^ref`；takenRefs/anchorAfter/unplaceTask 另屬 L |
| packages/backend/src/services/blockChildNote.ts | W | expandChildNote 經 planBlockExpand 寫 `^ref`；moveToChildNote 用 `#^id` needles（L） |
| packages/backend/src/services/harness/builtinSkills.ts | W | AI 系統提示教它寫 `[[Title#^blockid]]`（連結） |
| packages/backend/src/modules/tasks/lines.ts | L | syncTaskLine 以 parseBlocks().ref===block_ref 找任務行 |
| packages/backend/src/modules/review/service.ts | L | blockCardSides(markdown, block_ref) 在內文找卡片 |
| packages/backend/src/services/blockAnchors/blockNodeLink.ts | L | 以 parseBlocks ref 對 block_nodes.block_ref 建立 anchor_id 連結 |
| packages/backend/src/services/noteBlockRefs.ts | L | syncNoteBlockRefs 由 blockAnchors 讀文字 id 寫索引表 |
| packages/backend/src/services/blockCitations.ts | L | SQL position('#^') 加 blockCitations 解連結（連結） |
| packages/backend/src/modules/website/publishing/excerptEmbeds.ts | L | SQL 以 `^id` 字串找摘錄來源筆記 |
| packages/backend/src/modules/website/publishing/htmlUtils.ts | L | 站台 `[[Note#^id]]` 組 `target#^id` 去解析（連結） |
| packages/backend/src/services/panelChat.ts | L | answerLinks 解析 AI 回覆的 `#^id`（連結） |
| packages/backend/src/modules/website/publishing/drawingEmbeds.ts | L | 僅註解 `![[#^id]]`，用 embedMatches（連結） |
| packages/backend/src/modules/website/publishing/redaction.ts | N | 註解；只取連結的筆記部分 |
| packages/backend/src/modules/website/publishing/snapshot.ts | N | 註解；呼叫 expandPublishedExcerpts |
| packages/backend/src/services/backupRestore.ts | M | 還原以 line_ref 對 block_ref，靠舊 body 的 `^id`；切換後需映射 |
| packages/backend/src/services/backupArchive.ts | N | 把 block_ref 寫進 sidecar line_ref，當不透明值 |
| packages/backend/src/modules/importers/markdown/note.ts* | M | 匯入器 writeBlockIds:false 保留 Obsidian 舊 `^id`，需轉錨點 |
| packages/backend/src/routes/nodes.ts | N | block_ref 只是 API 參數／路由名 |
| packages/backend/src/services/blockAnchors/paragraphs.ts | N | 只讀 block_ref 欄位回傳 |
| packages/backend/src/services/blockAnchors/store.ts* | N | insertAnchor 產生錨點 id（不寫內文） |
| packages/backend/src/services/blockRefLookup.ts | N | 查 note_block_refs 表，不碰內文 |
| packages/backend/src/services/noteTasks.ts | N | SQL `NULL AS block_ref` 佔位 |
| packages/backend/src/services/tasksStore.ts | N | 從 block_nodes 取 block_ref 當不透明欄 |
| packages/backend/src/services/taskListFile.ts* | N | 匯出任務清單檔寫 `^t-ref`，非筆記內文也非區塊 id |
| packages/backend/src/modules/importers/markdown/taskLists.ts*, modules/tasks/blockTasks.ts* | N | line.ref 是任務行參照，非區塊 id |
| packages/backend/src/modules/rss/htmlToMarkdown.ts*, services/exportTasks.ts*, services/vaultPath.ts*, services/backupFile.ts*, services/sync/drawings.ts*, eslint-rules/require-read-gate.js* | N | 上標、檔名跳脫、UUID regex 等，無關 |
| packages/backend/src/dbSchema.generated.ts | D | 生成的型別（block_ref） |
| packages/backend/db/schema.sql | D | schema dump |
| packages/backend/db/migrations/104_block_nodes.sql | M | block_nodes.block_ref 定義（舊模型） |
| packages/backend/db/migrations/143_note_block_refs.sql | M | 一次性從 body 用 regex 抽 `^id` 建表 |
| packages/backend/db/migrations/147_tasks_into_notes.sql | M | 一次性遷移，往筆記寫 `{task} ^t-…` |
| packages/backend/db/migrations/028_node_block_ids.sql*, 091_block_ids_per_note.sql*, 117_drop_node_block_ids.sql* | M | 舊遷移，僅註解 |
| packages/backend/AGENTS.md*, AGENTS.md*, scripts/entrypoints.catalog.json | D | 規範／目錄指向 newBlockId、withBlockIds |

### 5. packages/backend tests
| file | cat | 理由 |
|---|---|---|
| packages/backend/src/test/agentSessions.integration.test.ts* | T | 送出提及後內文含 `這段 ^id`、回覆區塊 |
| packages/backend/src/test/blockAnchorsBatch1.integration.test.ts | T | block_nodes 對 anchor_id、獨立出去／收回 |
| packages/backend/src/test/blockAnchorsParity.test.ts* | T | md2html 標記並隱藏每個 `^id` |
| packages/backend/src/test/blockChildNote.integration.test.ts | T | 搬子筆記／展開，含 `^s1` 與連結改寫 |
| packages/backend/src/test/blockCitations.integration.test.ts | T | `^p1` 與 `[[T#^p1]]` 被引用次數 |
| packages/backend/src/test/blockNodes.integration.test.ts | T | 存檔補 `^id`、列隨文字同步 |
| packages/backend/src/test/blockRefFallback.integration.test.ts | T | `[[A#^id]]` 後援與 note_block_refs |
| packages/backend/src/test/blockReview.integration.test.ts | T | 複習卡 body 含 `{卡} ^q1` |
| packages/backend/src/test/bodyParsersLinear.test.ts | T | 各 parser 對 `^id` 內文線性時間 |
| packages/backend/src/test/compositionLaws.integration.test.ts | T | 段落 `^id` 加區塊連結交叉律 |
| packages/backend/src/test/guards/blockRef.guard.test.ts | T | 守門：後援／引用只能在指定檔（掃原始碼） |
| packages/backend/src/test/guards/dupSweep.guard.test.ts* | T | 守門：newBlockId 唯一擁有者 |
| packages/backend/src/test/properties/blockLinkIndex.property.integration.test.ts | T | 隨機編輯後比對 `^id` 與連結索引 |
| packages/backend/src/test/properties/markdownRenderStability.property.test.ts | T | 渲染穩定性含 `^ref` 錨點 |
| packages/backend/src/test/tasksIntoNotesMigration.integration.test.ts | T | 斷言 body 含 `{task} ^ref`（遷移 147） |
| packages/backend/src/test/tasksModule.integration.test.ts | T | place 任務：body `- first ^aaaaaa` 與 after_block_ref |
| packages/backend/src/test/helpers/roundTripRender.ts* | T | 夾具把 block.ref 渲染為 ` ^ref` 與連結 |
| packages/backend/src/test/headingAnchorsParity.test.ts* | T | 含 `[[Plan#^b1]]` 連結 |
| packages/backend/src/test/markdownExtract.test.ts* | T | extractWikilinks 去掉 `#^abc123` |
| packages/backend/src/test/panelChat.integration.test.ts* | T | 筆記 `^blk1` 與 AI 回覆連結 |
| packages/backend/src/test/properties/publishRedaction.property.integration.test.ts* | T | 隨機 body 含 `^blockId` 與連結 |
| packages/backend/src/test/publishAliasLinks.integration.test.ts* | T | `[[FAQ#^b1]]` 別名連結 |
| packages/backend/src/test/publishBlockEmbeds.test.ts* | T | `![[Shared#^k]]` 公開站嵌入 |
| packages/backend/src/test/publishBlockFallback.test.ts* | T | `[[Alpha#^p1]]` 公開站後援 |
| packages/backend/src/test/publishExcerptEmbeds.integration.test.ts* | T | excerptBlock(…,"ex1") 凍結進公開頁 |
| packages/backend/src/test/redaction.test.ts* | T | inert 連結含 `#^b1` |
| packages/backend/src/test/siteLinks.test.ts* | T | 匯出連結 `[[Target#^b1]]` |
| packages/backend/src/test/blockQuery.integration.test.ts | N | 直接 INSERT block_nodes，block_ref 不透明 |
| packages/backend/src/test/tasksAsNodes.integration.test.ts | N | 只比欄位名 block_ref |
| packages/backend/src/test/writePermissionMatrix.integration.test.ts | N | block_ref 只是請求參數 |
| packages/backend/src/test/permissionMatrix.test.ts*, tagRenameShape.integration.test.ts*, test/helpers/roundTripVault.ts*, test/properties/bodyMerge.property.test.ts* | N | 無關 regex／以 `^i` 當行唯一尾碼 |

### 6. packages/frontend src
| file | cat | 理由 |
|---|---|---|
| packages/frontend/src/lib/data/blockIdWriteback.ts | W | blockIdsForSave 呼叫 assignBlockIds 寫 id（含 caret 暫留） |
| packages/frontend/src/lib/data/draftActions.ts | W | 內部 withBlockIds 經 blockIdsForSave(newBlockId) 補 id |
| packages/frontend/src/hooks/useAgentMentions.ts* | W | 送出提及時內文插入 ` ^${blockId}` |
| packages/frontend/src/lib/editorParagraphActions.ts* | W | ensureBlockId 插入 ` ^id`；blockLink 組 `[[title#^id]]` |
| packages/frontend/src/lib/blockIdGen.ts* | W | generateBlockId/freshBlockId 產生寫入用 id |
| packages/frontend/src/modules/rss/rssQuote.ts | W | appendQuote 經 excerptBlock 寫 `^id`；excerptEmbed 組 `![[N#^id]]` |
| packages/frontend/src/lib/wikilinkTargets.ts | W | targetLinkBody 組 `#^ref ?? id`（連結） |
| packages/frontend/src/components/InfoParagraphs.tsx | L | parseBlocks 的 b.ref 當 blockRef 列出段落 |
| packages/frontend/src/components/NodeInspector.tsx | L | parseBlocks(body).length 決定是否有段落 |
| packages/frontend/src/lib/editorBlocks.ts | L | parseBlocksAndAnchors 與 marks.ref 供編輯器裝飾 |
| packages/frontend/src/lib/editorParagraphFrame.ts* | L | blockAnchors(doc) 畫段落框 |
| packages/frontend/src/lib/noteReveal.ts | L | lineOfBlock 找結尾為 `^ref` 的行 |
| packages/frontend/src/lib/editorLinkFollow.ts | L | anchorPosition 以 regex `\^id` 捲到段落 |
| packages/frontend/src/lib/blockSafety/recovery.ts | L | 用 blockAnchors 比對刪除段落與歷史版本 |
| packages/frontend/src/lib/blockSafety/editorCitations.ts | L | 比對 doc 切片是否為 `^${anchor.id}` |
| packages/frontend/src/lib/agentMentions.ts | L | markdown.includes(`^${replyBlockId}`) 判斷回覆在內文 |
| packages/frontend/src/modules/slides/analyze.ts | L | 標題 trailingBlockId 取 blockId、文字剝 id |
| packages/frontend/src/modules/slides/pages.ts | L | 頁面鍵用標題 `^id`（改錨點 id） |
| packages/frontend/src/modules/website/studio/fields.tsx* | L | blockAnchors 列出可選段落 |
| packages/frontend/src/modules/website/studio/HomeStudio.tsx | L | 組 `Title#^id` 給 parseEmbed（連結） |
| packages/frontend/src/lib/blockRefSearch.ts | L | 以 target.ref 比對最近段落（`((` 選單） |
| packages/frontend/src/lib/blockHome.ts | L | noteHasBlock 判斷 `[[A#^id]]` 後援（連結） |
| packages/frontend/src/lib/blockLinks.ts | L | 舊 `[[筆記#^id]]` 顯示讀取（連結） |
| packages/frontend/src/lib/embedDom.ts | L | 區塊嵌入以 blockId 解析／後援（連結） |
| packages/frontend/src/lib/embeds.ts | L | resolveEmbed/extractBlock 依 ref.blockId（連結） |
| packages/frontend/src/lib/editorPartLinks.ts | L | 舊 `#^id` 顯示為段落開頭（連結） |
| packages/frontend/src/lib/partLinkModule.ts | L | mayHavePartLinks 看 `#^`（連結） |
| packages/frontend/src/lib/noteExport.ts | L | 嵌入摘錄以 embedMatches.blockId 展開（連結） |
| packages/frontend/src/lib/noteExportExcerpts.ts | L | 同上，解析摘錄嵌入（連結） |
| packages/frontend/src/components/MarkdownRenderer.tsx | L | `[[Note#^id]]` 轉成 blockId，吃 data-block-id |
| packages/frontend/src/components/OverviewEditor.tsx | L | 引用選單以 `#^id` 在來源筆記搜尋 |
| packages/frontend/src/components/OverviewPreview.tsx | L | 讀 el.dataset.blockId 取引用次數 |
| packages/frontend/src/hooks/useOverviewMode.ts | L | openWikilink 帶 blockId 解後援（連結） |
| packages/frontend/README.md | D | 文件列出 `[[note#^id]]`、remarkBlockId |
| packages/frontend/src/lib/api.ts | N | block_ref 型別欄位 |
| packages/frontend/src/components/OndenQueryBlock.tsx | N | 查詢列 block_ref 不透明 |
| packages/frontend/src/lib/blockSafety/citations.ts | N | 依 row.block_ref 分組 |
| packages/frontend/src/lib/data/blockChildWriter.ts | N | 只把 block_ref 送給 API |
| packages/frontend/src/lib/data/taskWriter.ts | N | place API 回傳 block_ref |
| packages/frontend/src/lib/taskMirror.ts, lib/tasks/taskModel.ts | N | 任務列 block_ref 欄位 |
| packages/frontend/src/lib/data/reads.ts, lib/noteChat.ts, components/MarkdownEditor.tsx, lib/blockAnchorStore.ts*, hooks/useBlockChildNote.ts*, lib/toolbarLayout.ts*, hooks/useAgentMentions 以外 | N | 僅註解或只用 blockAnchorsEnabled |
| packages/frontend/src/components/TagsPanel.tsx, modules/daily/day/*.ts(x) | N | `.ref`／regex 無關 |

### 7. packages/frontend tests／e2e
| file | cat | 理由 |
|---|---|---|
| packages/frontend/src/test/remarkBlockId.test.ts | T | remarkBlockId 隱藏 `^id` 單元測試 |
| packages/frontend/src/test/properties/blockIds.property.test.ts | T | assignBlockIds 的隨機編輯性質 |
| packages/frontend/src/test/properties/editorCommands.property.test.ts | T | 編輯指令性質，含 `^id` 與 assignBlockIds |
| packages/frontend/src/test/draftBlockIds.test.ts | T | 草稿存檔補 `{t} ^id`、不丟身分 |
| packages/frontend/src/test/blockChildNote.test.tsx | T | 搬子筆記先寫 `^ref` 再呼叫伺服器 |
| packages/frontend/src/test/blockSafety.test.tsx | T | 被引用段落 `^c1` 刪除警示 |
| packages/frontend/src/test/editorParagraphActions.test.ts* | T | ensureBlockId 寫 ` ^aaa` 一次 |
| packages/frontend/src/test/editorLinkFollow.test.tsx* | T | `[[Plan#^abc-12]]` 跟隨捲動 |
| packages/frontend/src/test/blockAnchorsParity.test.tsx* | T | 渲染器標記並隱藏 `^id` |
| packages/frontend/src/test/blockEmbed.test.tsx* | T | `![[Source#^key]]` 嵌入來源含 `^key` |
| packages/frontend/src/test/blockHomeFallback.test.tsx* | T | `![[Alpha#^m1]]` 後援 |
| packages/frontend/src/test/embedEditSheet.test.tsx* | T | 編輯嵌入段落，不含 `^id` |
| packages/frontend/src/test/editorCompletionTargets.test.ts* | T | `[[Target#^` 補全不再造 id |
| packages/frontend/src/test/wikilinkTargets.test.ts* | T | `#^sh` 查詢與段落目標 |
| packages/frontend/src/test/useLinkTargets.test.tsx* | T | `Alpha#^` 目標列表 |
| packages/frontend/src/test/MarkdownEditorCrossNoteEmbed.test.tsx* | T | 打 `![[Alpha#^` 的補全 |
| packages/frontend/src/test/MarkdownEditorLinkTargets.test.tsx* | T | `[[#^` 寫成 `[[/words]]`、段落不變 |
| packages/frontend/src/test/MarkdownRendererParity.test.tsx* | T | `[[Note#^block]]` 轉發 blockId |
| packages/frontend/src/test/partLinks.test.tsx* | T | 舊 `[[筆記#^id]]` 仍可讀 |
| packages/frontend/src/test/partLinkLazy.test.tsx* | T | mayHavePartLinks 認 `#^` |
| packages/frontend/src/test/taskEmbed.test.tsx* | T | 任務行 `{task} ^b` 範圍 |
| packages/frontend/src/test/noteExport.test.tsx* | T | excerptBlock "k1" 與嵌入展開 |
| packages/frontend/src/test/noteChat.test.ts* | T | answerText 處理 `#^b1` 連結 |
| packages/frontend/src/test/infoAiTab.test.tsx* | T | AI 回覆含 `[[…#^b1]]` |
| packages/frontend/src/test/drawingEmbed.test.tsx* | T | resolveEmbed `#^b1` |
| packages/frontend/src/test/basesCompareParity.test.ts* | T | `[[plan#^abc123]]` 連結計數 |
| packages/frontend/src/test/properties/siteRedaction.property.test.ts* | T | 隨機 body 含 `段落 ^blk` 與連結 |
| packages/frontend/src/components/siteFrame/siteReading.test.tsx* | T | 目標 `^k1` 與連結／嵌入 |
| packages/frontend/src/modules/rss/rssQuote.test.tsx | T | 摘錄 `^id` 與 `![[A#^x]]` 嵌入 |
| packages/frontend/e2e/browser-app/paragraphs.mjs | T | 內文 `{演算法} ^b1…` 與 block-to-child |
| packages/frontend/e2e/fullstack/embedEditSheet.spec.ts* | T | 區塊嵌入編輯，`^pick` 保留 |
| packages/frontend/e2e/fullstack/zzDeepFind03.spec.ts* | T | 內文含 `[[Tgt#^blk]]` 連結 |
| packages/frontend/src/test/OndenQueryBlock.test.tsx | N | block_ref 當不透明欄 |
| packages/frontend/src/test/taskWriterStandalone.test.ts | N | place 回傳 block_ref 欄位 |
| packages/frontend/src/test/pdfjsCompat.test.ts*, test/workspaceHistory.test.tsx*, e2e/fullstack/helpers.ts*, zzDeepCol05.spec.ts*, zzDeepTag04.spec.ts* | N | 無關 regex |

### 8. other（scripts／docs）
| file | cat | 理由 |
|---|---|---|
| scripts/entrypoints.catalog.json | D | 目錄列出 newBlockId／withBlockIds |
| scripts/experiments/block-anchor-mapping/lib.ts* | N | 實驗腳本，自帶 markerText 寫 ` ^id`（不進產品） |
| scripts/build-browser.mjs*, scripts/changelog.sh*, scripts/dupLib.mjs* | N | 無關 regex |

### 摘要（表列數；一列可含多檔，`*` 為補查檔）
1. 原 87 檔全數入表，另補查約 60 檔（含無關 regex 的 N）；表列數 W20 / L49 / M6 / N36 / T82 / D6。
2. W 共 20 檔，後端 10、前端 7、markdown 3；其餘寫入點都經由這些函式。
3. W markdown：blocks.ts `assignBlockIds`（寫 ` ^id`／重命名重複 id，內部 `renameAt`）；blockChild.ts `planBlockExpand`；excerpt.ts `excerptBlock`。
4. W 後端：blockNodes.ts `withBlockIds`；nodeUpdate.ts `updateNode`（addBlockIds→withBlockIds）；noteCreate.ts `createNote`（withBlockIds）；aiSuggestions.ts（acceptSuggestion 路徑 writeBlockIds:true）；agentTools/updateNode.ts*（writeBlockIds:true）。
5. W 後端續：aiSuggestionBlocks.ts `keepingBlockId`；agentSessions.ts `createSession`（補 ` ^anchor`）、`replyBlock`／`withReplyBlock`（`  ^replyId`）；tasks/placement.ts `placeTask`（`{task} ^ref`，`takenRefs`/`newRef`）；blockChildNote.ts `expandChildNote`；harness/builtinSkills.ts（提示 AI 寫 `[[Title#^blockid]]`）。
6. W 前端：lib/data/blockIdWriteback.ts `blockIdsForSave`；lib/data/draftActions.ts `withBlockIds`（私有，呼叫 blockIdsForSave）；hooks/useAgentMentions.ts*（送出提及的 handler）；lib/editorParagraphActions.ts* `ensureBlockId`、`blockLink`。
7. W 前端續：lib/blockIdGen.ts* `generateBlockId`／`freshBlockId`；modules/rss/rssQuote.ts `appendQuote`、`excerptEmbed`；lib/wikilinkTargets.ts `targetLinkBody`（連結 `#^id`）。
8. 切換開關：`updateNode` 的 `writeBlockIds`（true 僅 aiSuggestions、agentTools/updateNode；其餘呼叫端皆 false）與 `createNote` 的 `writeBlockIds`；移除 withBlockIds 即可收掉伺服端寫入。
9. M：backupRestore.ts（line_ref↔block_ref）、importers/markdown/note.ts*（Obsidian 匯入保留舊 `^id`）、遷移 104/143/147（+028/091/117 註解）；需要「舊 `^id` 讀一次轉成 anchor」的轉換器。
10. L 重點需改走 block_anchors（span.from===block.start）：blocks.ts 的 parseBlocks/blockAnchors（讀取源頭）、blockCard、tasks/lines+placement、review/service、blockNodeLink、noteBlockRefs、noteReveal、editorLinkFollow、editorBlocks、recovery、editorCitations、slides pages/analyze；連結類 L（`#^id`）依 S6 另改成 `[[筆記/段落]]`。
