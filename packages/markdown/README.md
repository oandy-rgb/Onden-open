# @onden/markdown

Onden 唯一的一套 Markdown 渲染管線（W38c，見 `docs/architecture/site-render-model.md`）。
App 的 `MarkdownRenderer`（react-markdown）和後端的匯出（unified → HTML）用同一份
remark／rehype 外掛清單與同一份 sanitize schema，所以同一篇筆記在編輯器預覽、公開網站
和下載的匯出裡長得一樣。

```ts
import { ondenMarkdown } from "@onden/markdown";
const md = ondenMarkdown({ profile: "published", wikilinkHref: ({ target, blockId, heading }) => "…" });
// react-markdown: remarkPlugins={md.remarkPlugins} remarkRehypeOptions={md.remarkRehypeOptions}
//                 rehypePlugins={md.rehypePlugins}，內容先經過 md.prepare(text)
```

- **兩種 profile，差別只在內嵌 HTML**：`app` 會解析筆記裡的 HTML 再消毒；`published`
  （公開網站、Studio、匯出）把它當文字顯示。callouts、數學（remark-math + KaTeX）、
  程式碼上色、`^block-id`／`key:: value` 隱藏、frontmatter 兩邊都一樣。
- **標題錨點只有一套**（D62，`headingAnchors.ts`）：`headingAnchors(markdown)` 列出筆記的
  標題與 id（Unicode slug、重複的依 GitHub 規則加 `-1`、`-2`），管線把同一個 id 放在
  渲染出的 h1–h6 上；消毒會加上 `user-content-`（`DOM_ID_PREFIX`），所以連到標題要用
  `headingFragment`／`anchorHref`。發布網站的目錄與 `[[Note#標題]]` 都讀它。
- **各渲染器自己負責**：元素怎麼畫（React 元件：wikilink 按鈕、mermaid、嵌入影片、
  任務勾選框；伺服器端則是 HTML 後處理）以及 `[[wikilink]]` 指向哪裡（`wikilinkHref`）。

## 怎麼被讀到

- 前端（Astro、published SPA、Capacitor、vitest）透過設定檔裡的 alias 直接讀 `src/`。
- `package.json` 的 `types` 指向 `src/`，型別檢查直接看原始碼。
- 只有需要純 JS 的地方（後端的正式映像，`node dist/…`）才跑 `npm run build` 產生 `dist/`。

測試：`npx vitest run`（在這個目錄）。檔案與檔案內的測試都隨機排序，每次執行開頭會印出 seed（`Running tests with seed "…"`）；用 `npx vitest run --sequence.seed=<seed>` 重跑同一個順序。
