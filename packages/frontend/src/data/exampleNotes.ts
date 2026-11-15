// First-run onboarding seed. These are NOT a tutorial overlay or a special
// "help" surface — they are ordinary, fully-editable notes whose BODY teaches
// Onden by example. They are created through the same offline-aware node-create
// the New button uses, so they behave exactly like anything else: rename them,
// rewrite them, link them, delete them.
//
// Seeded ONCE on a truly-empty workspace (gated in BuilderApp behind the
// `onden.exampleSeeded` localStorage flag, so deleting them never re-seeds).
//
// Locale-aware: a brand-new zh-TW user gets the notes in Chinese, everyone
// else in English. Pattern source: super-productivity's example-tasks (MIT) —
// adapted, not copied: same "teach by being real, deletable content" idea.

import { getLocale } from "../lib/i18n";

export type ExampleNote = {
  title: string;
  markdown: string;
};

const EN: ExampleNote[] = [
  {
    title: "Capture a thought",
    markdown: `Anything on your mind goes here first — no folders, no decisions.

Press the **+** in the sidebar to start a note, or **Capture** at the top to jot something down without leaving what you're doing. Every action is also in the command palette (**Ctrl/⌘ K**); shortcuts are listed and changeable in Settings › Keyboard shortcuts.

The flow Onden is built around:

- **Capture** a thought the moment you have it.
- Turn the ones that need doing into a **task** — write \`- [ ] do the thing\`, select the line and press the task button (or send every open item at once from the note's … menu). It then shows up in Tasks with a due date and reminders.
- Want one note per day that your captures and tasks land in? **Daily notes** is built in and already on: press Today and write that day's note, and Daily notes appears in the navigation.

Capture loosely now; shape it later. That's the whole idea.`,
  },
  {
    title: "Tags are capabilities",
    markdown: `A \`#tag\` in Onden isn't just a label — it's a **capability you grant**.

Add one to a note with **+ Tag** under its title (a \`#word\` typed in the text stays plain text). But a tag can also *do* something: it can give a note a shape (fields to fill in), put it in a collection, or hand a capability to your agent.

This is the core idea behind Onden:

- A **node** is a connection — a note, a task, a page, a person.
- A **tag** is a capability — what that node can do, and who's allowed to do it.

So tagging isn't filing. It's deciding what something is *able to be*. Start with a plain \`#tag\`; the power is there when you want it.`,
  },
  {
    title: "Connect ideas on a canvas",
    markdown: `Some thinking is spatial. Open the **Canvas** lens (the tab at the top of any note) and your ideas become cards you can arrange.

Try it:

- Drag notes onto the canvas and move them around.
- Draw a line between two cards to **connect** them — that link is real, not decoration.
- Group related cards together; zoom out to see the shape of your thinking.

A note, its outline, and its canvas are the **same thing** seen three ways. Nothing is locked to one view.`,
  },
  {
    title: "Your agent, governed by your inbox",
    markdown: `Onden is built for working *with* an AI agent — but on your terms.

Your agent can capture, draft, tag, and connect things for you. Every change it makes shows up in your **Inbox** for you to review:

- **Keep** what's good.
- **Reject** what isn't — and it's cleanly undone.

Anything risky or outbound (like publishing) waits for your **approval** before it runs. You stay in charge; the agent does the legwork.

This is the deal: an agent powerful enough to be useful, governed enough to be trusted.

---

Delete me when you're done — this space is yours.`,
  },
];

const ZH: ExampleNote[] = [
  {
    title: "捕捉一個念頭",
    markdown: `任何浮現的念頭都先丟這裡 — 不用分資料夾、不用做決定。

按側欄的 **+** 開始一則筆記，或按上方的 **捕捉** 隨手記下，不必離開手邊的事。所有動作也都在指令面板（**Ctrl/⌘ K**）裡；快捷鍵可以在 設定 › 鍵盤快捷鍵 查看和修改。

Onden 圍繞的流程：

- 念頭一出現就 **捕捉** 下來。
- 需要做的，轉成 **任務** — 寫下 \`- [ ] 要做的事\`，選取那一行再按任務按鈕（或從筆記的 … 選單「把清單項目轉成待辦」一次全部送出），它就會出現在「任務」裡，可以設期限與提醒。
- 想要每天一則筆記，讓捕捉與任務都落在那裡？**日記** 是內建功能，已經開著：按「今日」寫下今天那一則，導覽列就會出現「日記」。

現在先鬆鬆地捕捉，之後再整理。這就是全部的訣竅。`,
  },
  {
    title: "標籤就是能力",
    markdown: `Onden 裡的 \`#tag\` 不只是標籤 — 它是 **你授予的一種能力**。

用筆記標題下方的 **+ 標籤** 把它貼上（在內文打的 \`#字\` 只是文字）。但標籤也能 *做事*：它能給筆記一個形狀（要填的欄位）、把它放進一個集合，或把某種能力交給你的 agent。

這是 Onden 的核心理念：

- **節點（node）** 是一個連結 — 一則筆記、一個任務、一個頁面、一個人。
- **標籤（tag）** 是一種能力 — 那個節點能做什麼、誰被允許做。

所以標記不是歸檔，而是決定某個東西 *能成為什麼*。先從單純的 \`#tag\` 開始；需要時，力量就在那裡。`,
  },
  {
    title: "在白板上連結想法",
    markdown: `有些思考是空間性的。打開 **Canvas（白板）** 鏡頭（任何筆記頂端的分頁），你的想法就變成可以排列的卡片。

試試看：

- 把筆記拖到白板上，自由移動。
- 在兩張卡片之間畫一條線來 **連結** 它們 — 那條連結是真的，不是裝飾。
- 把相關的卡片聚在一起；縮小來看見你思考的形狀。

一則筆記、它的大綱、它的白板，是 **同一個東西** 的三種樣貌。沒有任何東西被鎖在單一檢視裡。`,
  },
  {
    title: "你的 agent，由你的收件匣治理",
    markdown: `Onden 是為了 *與* AI agent 協作而打造 — 但照你的規則來。

你的 agent 能替你捕捉、起草、標記、連結。它做的每一個變更都會出現在你的 **收件匣** 等你審核：

- 好的就 **保留**。
- 不好的就 **拒絕** — 而且會乾淨地復原。

任何有風險或對外的動作（例如發布）都會等你 **核准** 才執行。你掌控全局；agent 做苦力。

這就是這份默契：一個強到有用、又被治理到可信任的 agent。

---

用完就刪掉我吧 — 這個空間是你的。`,
  },
];

/** First-run seed notes for the active locale (zh-TW users get Chinese). */
export function getExampleNotes(): ExampleNote[] {
  return getLocale() === "zh-TW" ? ZH : EN;
}
