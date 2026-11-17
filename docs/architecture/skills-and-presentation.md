# 技能（筆記變成 AI 技能）

> 狀態：現行
> 涵蓋：packages/markdown/src/skillFile.ts, packages/backend/src/services/harness/noteSkills.ts, packages/backend/src/modules/skills/index.ts, packages/frontend/src/modules/skills/**, packages/frontend/src/lib/createSkillNote.ts, packages/frontend/src/lib/editorFrontmatter.ts

何時讀：改技能筆記的格式、技能的開關與清單、建立或匯入技能時。檔名保留是因為別處連到這裡；簡報（切頁、播放）的現行規則已獨立成 [presentation.md](presentation.md)，
簡報視角在 [decisions-slides.md](../agents/decisions-slides.md)。這份文件原本還包含內建 AI 時期的設計比較、「用技能…」流程與「AI 心得」，
原文在 [skills-and-presentation-history.md](skills-and-presentation-history.md)。

**Onden 不自己執行技能。** 內建的 API AI 在 2026-10-23 移除，技能只透過 MCP 提供給使用者自己的 AI（見 [harness.md](harness.md)）。

## 技能是「功能」，不是標籤（業主 2026-10-31）

判斷法：功能關掉後這個分類還有沒有意義——`#書籍` 有（標籤），`#技能` 沒有（功能）。標籤只留給使用者自己的主題。
所以介面上不出現 `#技能`：筆記資訊欄有「當成技能」開關（開關就是加／移除模組的內部標籤，資料不變），標籤列、標籤樹、搜尋、指令面板、`#` 選單、標籤選擇器都看不到它。
技能預設也讓 AI 自己挑（`ai` 沒寫或 `auto`），寫 `ai: manual` 才只在使用者點名時用（見 [harness.md](harness.md)〈AI 自己挑技能〉）。

| 地方 | 內容 | 程式 |
| --- | --- | --- |
| 筆記資訊欄 | 「當成技能」開關（技能功能開著才出現）；打開後展開「什麼時候用」「套用在（標籤 chips ＋）」「給 AI 用」 | `FrontendModule.noteSwitch`（`modules/types.ts`）→ `components/NoteSwitches.tsx`；欄位 `modules/skills/SkillNoteFields.tsx` |
| 設定 › 功能 › 技能 | 「你的技能 · N」清單（含關著的）、每列一個「給 AI 用」開關；內建技能一組；「新增技能」「匯入 SKILL.md」 | `modules/skills/SkillsSettings.tsx`；清單來自 `GET /api/skills`（每列有 `aiUse`） |
| 套用技能的標籤 | 技能筆記的「套用在」設定（`applies_to`）；這些標籤的筆記頂端出現「交給 AI：技能名」按鈕（寫入 `@ai /[[技能]]` 並送出，同打字） | `modules/skills/SkillHandoffAction.tsx` |

標籤頁沒有技能專區：標籤頁的「用到的技能」與「加技能」區塊在 2026-11-13 拿掉（擁有者 2026-11-12：使用者的標籤只有欄位與檢視）。

- **一份資料**：技能的設定（`description`、`output`、`applies_to`、`ai`）都在筆記 frontmatter。資訊欄、功能頁都只是改那則筆記的文字
  （`modules/skills/changeSkill.ts` → `drafts.editText`）。`@onden/markdown` 的 `readSkillSettings`／`withSkillSettings` 是唯一讀寫這幾個鍵的地方（後端 `noteSkills.ts` 讀同一份格式）。
- **標籤從哪都看不到**：`lib/nodeTags.ts` 的 `isTagShown` 是「標籤顯示不顯示」的唯一規則，`registerNoteSwitchModule`（`modules/index.ts` 對每個宣告
  `noteSwitch` 的模組登記）讓它對該模組的標籤永遠回 `false`，連輸入完整名稱也不供應。擁有者自己隱藏的標籤（「已隱藏」清單）不受影響。
- 內建技能的「給 AI 用」存在帳戶設定（`aiSkillsOff`：關掉的內建技能 id，沒有就是全開；`modules/skills/aiSkillsOffPref.ts`）。

## 技能筆記的格式

```markdown
---
description: 用我的口吻寫讀書心得，先摘要再談三個收穫
output: note        # note（存成新的子筆記）| insert（插入游標處）| slide（簡報的最後一頁）
applies_to: 論文    # 選填：這些標籤的筆記頂端有「交給 AI：技能」按鈕
ai: manual          # 選填：manual＝只在點名時用；沒有這個鍵或 auto＝AI 覺得合適會自己挑
---
你是我的讀書助理。根據提供的筆記……
```

- 標題 ＝ 技能名稱；正文 ＝ 指示。frontmatter 的 `description`、`output` 等鍵與其他筆記一樣存成屬性，不必新增欄位。
- `output` 是給執行技能的 AI 的提示（結果放哪裡），Onden 不據此自己寫入。
- 不認得的鍵（例如舊的 `tools`）被略過；工具迴圈已不存在。
- 「AI 心得」這類固定頁面不內建（使用者 2026-10-15 決定）：需要的人寫一則 `output: slide` 的技能筆記。
- 筆記第 1 行開始的 `---`…`---` 區塊在編輯器收成一個小而淡的按鈕（`⚙ 設定：…`），按下或游標進入才展開原始 YAML，且不套標題樣式（`lib/editorFrontmatter.ts`）。
  預覽與發佈頁不顯示它（`stripFrontmatter`）；儲存與解析不變。

## 給外部 AI（MCP）

- 每個技能是一個 **MCP prompt**（`prompts/list`、`prompts/get`，`routes/mcpProtocol.ts`、`services/agentTools/registry.ts` 的 `callPrompt`）。清單只含開著「給 AI 用」的技能；
  token 讀不到的技能不會出現；prompt 要有讀筆記文字的權限。
- agent 工具 `loadSkill`（`services/agentTools/loadSkill.ts`）讓 AI 從 `<available_skills>` 清單挑一個載入完整指示；只能載入開著「給 AI 用」的技能。
- 標準 `SKILL.md` 匯出：`GET /api/skills/:id/skill.md`（格式 `skillMdMarkdown`）。

## 不手寫 frontmatter 的建立方式

建立技能筆記的唯一入口是前端的 `createSkillNote()`（`lib/createSkillNote.ts`，元件用 `useCreateSkillNote()`）；設定寫進 frontmatter，格式由 `@onden/markdown` 的 `skillNoteMarkdown()` 負責，
與上面的手寫格式相同。技能功能預設開著；擁有者關掉後，建立技能會把它重新打開。筆記放在新筆記一般會放的位置（預設只有自己）；技能要在開啟 `external_ai` 的空間才會送給 AI。

- **匯入 SKILL.md**（設定 › 功能 › 技能、⌘K）：`parseSkillMd()` 讀 frontmatter（`name` 當標題、`description`、`output`、`applies_to`、`ai`），其他欄位略過並列出；
  正文提到腳本或附帶檔案時只匯入文字並說明。不讀 .zip。
- **＋ 新增技能**（⌘K「新增技能」）：`NewSkillDialog` 收名稱、「要 AI 做什麼」、結果放哪裡（新筆記／插入游標處／簡報，預設新筆記）、選填的 `applies_to` 標籤名稱與一行 description，一律經 `useCreateSkillNote` 建立並開啟，沒有新的寫入路徑。
