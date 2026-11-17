# 技能與簡報模式：內建 AI 時期的設計與當時的決定（歷史）

> 狀態：歷史紀錄（寫於 2026-10-14；現行規則見 [skills-and-presentation.md](skills-and-presentation.md)）

以下從 skills-and-presentation.md 原文搬來，未改寫；現況以現行文件與程式為準。
> 2026-10-14，note-0f 依使用者的需求寫成；使用者授權「遇到決定你自己下」，以下決定可以之後調整。
>
> **2026-10-23：Onden 不再自己執行技能。** 內建的 API AI（`POST /api/ai/run`、設定 › AI 的金鑰與模型）已移除，技能只透過 MCP prompts 給使用者自己的 AI 執行，見 [harness](harness.md)。技能筆記格式、`#技能` 模組標籤、簡報切頁規則仍以本文件為準。下文凡寫到「Onden 內建 AI」、`tools`、「用技能…」、「AI 心得」、「存成技能」的段落，是移除前的設計，現在不存在。

> **2026-10-31 業主決定（看過示意後「先這樣試試」）：技能是「功能」，不是標籤。** 判斷法：功能關掉後這個分類還有沒有意義——`#書籍` 有（標籤），
> `#技能` 沒有（功能）。標籤只留給使用者自己的主題。所以介面上不再出現 `#技能`：筆記資訊欄有「當成技能」開關（開關就是加／移除模組的內部標籤，
> 資料不變、不寫遷移），標籤列、標籤樹、搜尋、指令面板、`#` 選單、標籤選擇器都看不到它。下文「設計比較」的 B 案（模組標籤）仍是資料的存法，
> 只是使用者不再看到那個標籤；「在標籤頁就能看到所有技能」改成「設定 › 功能 › 技能」的清單，標籤頁則有「用到的技能」區（見〈2026-10-31 技能是功能〉）。
> 技能**預設也讓 AI 自己挑**（取代 2026-10-22「技能一律手動點名」）：見 [harness](harness.md)〈AI 自己挑技能〉。

## 需求

1. 任何一則筆記，只要貼上某個標籤，就變成一個 AI「技能」：一段寫好的指示，可以直接套用到目前串接的 AI。
2. 簡報模式：把筆記當投影片播放。
3. 兩者結合：簡報時用技能讓 AI 根據你自己的筆記，生成專屬的心得或分析。

## 目前串接的 AI

| 串接 | 誰在用 | 現況 |
| --- | --- | --- |
| ~~Onden 內建（API 金鑰，設定 › AI）~~ | 已移除（2026-10-23） | — |
| MCP（`/api/mcp`） | 外部 agent，例如 命令列或桌面的 MCP 用戶端 | `routes/mcp*.ts`，agent 工具註冊在 `services/agentTools/registry.ts` |

技能要能同時用在這兩條。

## 設計比較：技能怎麼標記

**A. 任意筆記加一個系統屬性（`_skill=true`）**
- 優點：不必建標籤。
- 缺點：看不出哪些筆記是技能；不能用標籤頁管理、批次整理；和模組庫「功能用標籤引入」的方向不一致。

**B. 模組標籤 `#技能`（模組 `skills`，在模組庫裡引入）** ← 採用
- 和 `#複習`、`#論文` 一樣：引入模組時建立或認領模組標籤；其他標籤可以 extends 它（例如 `#寫作技能` extends `#技能`）。
- 技能就是一般筆記：可以讀它的人才能用它，空間規則照舊。
- 在標籤頁就能看到所有技能。

## 2026-10-31 技能是功能

| 地方 | 內容 | 程式 |
| --- | --- | --- |
| 筆記資訊欄 | 「當成技能」開關（技能功能開著才出現）；打開後展開「什麼時候用」「套用在（標籤 chips ＋）」「給 AI 用」 | `FrontendModule.noteSwitch`（`modules/types.ts`）→ `components/NoteSwitches.tsx`；欄位 `modules/skills/SkillNoteFields.tsx` |
| 設定 › 功能 › 技能 | 「你的技能 · N」清單（含關著的）、每列一個「給 AI 用」開關；內建技能一組；「新增技能」「匯入 SKILL.md」 | `modules/skills/SkillsSettings.tsx`；清單來自 `GET /api/skills`（每列多一個 `aiUse`） |
| 標籤頁 | （2026-11-13 拿掉）原本的「用到的技能」與「加技能」區塊已移除：使用者的標籤只有欄位與檢視（擁有者 2026-11-12 的決定）。技能套用在哪些標籤，仍在技能筆記資訊欄的「套用在」設定 | — |

- **一份資料**：技能的設定（`description`、`output`、`applies_to`、`ai`）都在筆記 frontmatter。資訊欄、功能頁都只是改那則筆記的文字
  （`modules/skills/changeSkill.ts` → `drafts.editText`），所以「技能那邊的套用在」和「標籤那邊的用到的技能」是同一份。
  `@onden/markdown` 的 `readSkillSettings`／`withSkillSettings` 是唯一讀寫這幾個鍵的地方（後端也用同一份格式）。
- **標籤從哪都看不到**：`lib/nodeTags.ts` 的 `isTagShown` 是「標籤顯示不顯示」的唯一規則，`registerNoteSwitchModule`（`modules/index.ts` 對每個宣告
  `noteSwitch` 的模組登記）讓它對該模組的標籤永遠回 `false`——連輸入完整名稱也不供應。擁有者自己隱藏的標籤（「已隱藏」清單）不受影響。
  這是為「稍後讀」「複習」之後照同一個做法預留的擴充點，這次只接技能。
- 內建技能的「給 AI 用」存在帳戶設定（`aiSkillsOff`：關掉的內建技能 id，沒有就是全開）。

## 技能筆記的格式

```markdown
---
description: 用我的口吻寫讀書心得，先摘要再談三個收穫
output: note        # note（存成新的子筆記）| insert（插入游標處）| slide（簡報的最後一頁）
applies_to: 論文    # 選填：這些標籤的筆記頂端有「交給 AI：技能」按鈕
ai: manual          # 選填（2026-10-31）：manual＝只在點名時用；沒有這個鍵或 auto＝AI 覺得合適會自己挑
tools: notes, web   # 選填（H5）：notes 讓 AI 自己搜尋、閱讀你的筆記；web 讓它搜尋網路、開啟出現過的網址
---
你是我的讀書助理。根據提供的筆記……
```

- 標題 = 技能名稱；正文 = 指示（system prompt）。
- frontmatter 照現有規則變成屬性（`description`、`output`），不必新增欄位。
- ~~`tools`~~：工具迴圈已移除，這個鍵現在被視為不認得的鍵。
- 「AI 心得」這類固定頁面不內建（使用者 2026-10-15 決定）：需要的人寫一則 `output: slide` 的技能筆記。

## 套用技能

### 1. ~~Onden 內建 AI~~（已移除，以下為歷史設計）
- `POST /api/ai/skills/:skillId/apply`，body 是 `{ nodeIds?: string[], tagId?: string, extra?: string }`。
- 伺服器組出：system = 技能正文；user = 目標筆記的標題與正文（以及 `extra`），回傳生成的文字。
- **權限與隱私**：
  - 技能本身和目標筆記都要讀得到；
  - 只有所在空間開啟 `external_ai` 的筆記才會送給模型，沿用 `ask.ts` 的 `filterByCapability`；
  - 和 ask、transform 共用同一個每分鐘配額；
  - 套用一次不寫入任何東西，存成筆記是另一個明確的動作。
- 介面：筆記的「⋯」選單和 ⌘K 都有「用技能…」→ 選技能 → 顯示結果 → 依 `output` 存成子筆記、插入，或放到簡報。

### 2. 串接的外部 agent（MCP）
- 每個技能註冊成 **MCP prompt**（`prompts/list`、`prompts/get`），MCP 用戶端會把它列成可以直接呼叫的 prompt；token 讀不到的技能不會出現。
- 加一個 agent 工具 `listSkills`（列名稱和 description），讓 agent 自己判斷要用哪一個。
- 之後再考慮：把技能匯出成標準的 `SKILL.md`。

## 簡報模式（模組 `presentation`）

- 一則筆記就是一份簡報：遇到 `---` 分隔線就換頁；沒有分隔線時，以 `##` 標題分頁。
- 進入方式：筆記「⋯」→「簡報」，或 ⌘K。全螢幕，可以用鍵盤（← →、Esc）或觸控滑動切換。
- 手機：直式時一次顯示一頁，左右滑動切換。
- **結合技能**：簡報工具列有一個「AI 心得」按鈕 → 選技能（預設列出 `output: slide` 的技能）→ 把這份簡報的筆記（加上同標籤的筆記作為背景）交給技能 → 結果作為最後一頁顯示，可以另存成子筆記「心得」。

## 工作包

原 harness H1–H5 中，只有技能目錄與 MCP prompts（H2）與範圍取材（H3）留下；模型閘道、簡報生成、工具迴圈（H1、H4、H5）已隨內建 AI 移除。

## 不手寫 frontmatter 的建立方式（2026-10-21）

建立技能筆記的唯一入口是前端的 `createSkillNote()`（`modules/skills/createSkillNote.ts`，元件用 `useCreateSkillNote()`）；設定寫進 frontmatter，格式由 `@onden/markdown` 的 `skillNoteMarkdown()` 負責，與上面的手寫格式相同，後端目錄（`noteSkills.ts`）不需要改。技能模組尚未引入時，先用既有的 `ModuleImportConfirm` 問一次，引入後才建立並開啟新筆記。筆記放在新筆記一般會放的位置（預設只有自己），執行技能仍需要開啟 `external_ai` 的空間。

- **存成技能**（問答面板，面板已移除）：指示 = 這段對話裡你問的問題（多題為編號清單），不含回答；標題取第一題的短形式，`description` 取第一題，`output: note`；回答去掉 `[n]` 標記後放在正文 `## 範例` 區段。執行時 harness 送出 frontmatter 之後的整個正文，範例區段一併送出；匯出 SKILL.md 也是整個正文。不呼叫模型。
- **匯入 SKILL.md**（側欄「+」的「匯入 SKILL.md…」，由技能模組提供）：`parseSkillMd()` 讀 frontmatter（`name` 的連字號變空格當標題、`description`、`output`、`applies_to`；`tools` 視為不認得的鍵），其他欄位略過並列出；正文提到腳本或附帶檔案時只匯入文字並說明。不讀 .zip。匯出再匯入的 SKILL.md 等價（`skillImportRoundTrip.test.ts`）。
- **＋ 新增技能**（⌘K「新增技能」）：`NewSkillDialog` 收名稱、「要 AI 做什麼」、結果放哪裡（新筆記／插入游標處／簡報，預設新筆記）、選填的 `applies_to` 標籤名稱（逗號分隔，標籤建議用 datalist）與一行 description，一律經 `useCreateSkillNote` 建立並開啟，沒有新的寫入路徑。技能由你自己的 AI 透過 MCP 執行。
- **編輯器裡的 frontmatter**：筆記第 1 行開始的 `---`…`---` 區塊在編輯器收成一個小而淡的按鈕（`⚙ 設定：description · output`），按下或游標進入才展開原始 YAML，且不套標題樣式（`lib/editorFrontmatter.ts`）。預覽與發佈頁本來就不顯示它（`stripFrontmatter`）；儲存與解析不變。
