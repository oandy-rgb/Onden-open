// The notes a first open starts with, and the one switch that removes them.
//
// They are made through the app's own routes (POST /api/tags, POST /api/nodes), so they are ordinary notes in every
// way: events, history, search, links. Which rows are samples is remembered in a small table of the host
// (not a migration: it is the browser app's own bookkeeping, and a server never has it).

import { readAppState, writeAppState } from "./appState.js";

type Fetch = (request: Request) => Promise<Response>;
type SampleRows = { notes: string[]; tags: string[] };

const STATE_KEY = "sample-notes";

const readRows = () => readAppState<SampleRows>(STATE_KEY);

/** Whether the samples were ever made here (they stay "made" after being cleared, so they never come back). */
export async function sampleNotesState(): Promise<boolean> {
  return (await readRows()) !== undefined;
}

/** The welcome note (the first sample), or null when there are no samples. */
export async function welcomeNoteId(): Promise<string | null> {
  return (await readRows())?.notes[0] ?? null;
}

/** The ids of the sample notes still to clear (empty after clearing). */
export async function sampleNoteCount(): Promise<number> {
  return (await readRows())?.notes.length ?? 0;
}

async function call<T>(fetchLocal: Fetch, origin: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetchLocal(new Request(new URL(path, origin).href, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
  return (await response.json().catch(() => ({}))) as T;
}

const newId = () => crypto.randomUUID();

/** The built-in tags every database starts with (migrations 012/015/020). A new trial has no use for them yet and an empty
 *  English tag list, in a Chinese-first first open, only confuses. They go to the trash (recoverable), so the lists and the
 *  graph start with the person's own tags; a template or a starter pack makes the tag again when it is first used.
 *  #admin-only can never be applied here (the trial has no administrator). Workspaces that already exist are not touched:
 *  this runs only on the very first open of the browser app. */
export const UNUSED_SEED_TAG_NAMES = ["admin-only", "archive", "book", "meeting", "person", "project"] as const;

export async function retireUnusedSeedTags(fetchLocal: Fetch, origin: string): Promise<void> {
  const listed = await call<{ tags?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>>(fetchLocal, origin, "GET", "/api/tags");
  const tags = Array.isArray(listed) ? listed : listed.tags ?? [];
  for (const tag of tags) {
    if (!(UNUSED_SEED_TAG_NAMES as readonly string[]).includes(tag.name)) continue;
    try {
      await call(fetchLocal, origin, "DELETE", `/api/nodes/${tag.id}`);
    } catch {
      // Refused (a tag the server insists on keeping): hide it instead; the tag itself stays.
      await call(fetchLocal, origin, "PATCH", `/api/nodes/${tag.id}`, { hidden: true }).catch(() => undefined);
    }
  }
}

/** Zh-TW sample notes: a welcome, a how-to, tasks, a reading note with a tag, and links between them. */
export async function seedSampleNotes(fetchLocal: Fetch, origin: string): Promise<void> {
  const post = <T>(path: string, body: unknown) => call<T>(fetchLocal, origin, "POST", path, body);
  const sampleTag = newId();
  const readingTag = newId();
  await retireUnusedSeedTags(fetchLocal, origin);
  await post("/api/tags", { id: sampleTag, name: "範例" });
  await post("/api/tags", { id: readingTag, name: "讀書" });

  const welcome = newId(), howTo = newId(), todo = newId(), reading = newId(), where = newId();
  const notes: Array<{ id: string; title: string; markdown: string; tags: string[] }> = [
    {
      id: welcome, tags: [sampleTag],
      title: "歡迎來到 Onden 試用版",
      markdown: [
        "這裡是 Onden 的**試用版**：不用伺服器、不用註冊，打開就能寫。",
        "",
        "> 你寫的內容只存在這個瀏覽器裡。換裝置、清除瀏覽資料、或換一個瀏覽器，都看不到它們。重要的筆記請到「設定」下載備份。",
        "",
        "先看這幾則範例：",
        "",
        "- [[快速上手]]：怎麼新增、連結和整理筆記",
        "- [[今天要做的事]]：任務長什麼樣子",
        "- [[讀書筆記：作業系統]]：標籤與連結的用法",
        "- [[資料存在哪裡]]：試用版的限制與搬家方式",
        "",
        "看完不需要的話，可以在設定裡一鍵清掉全部範例。",
      ].join("\n"),
    },
    {
      id: howTo, tags: [sampleTag],
      title: "快速上手",
      markdown: [
        "## 寫筆記",
        "",
        "筆記就是一頁 Markdown，打字時會自動保存。用兩個中括號連到別的筆記，例如 [[歡迎來到 Onden 試用版]]。",
        "",
        "## 整理",
        "",
        "- 用 `#標籤` 或在筆記上加標籤來分類",
        "- 筆記底下可以再放筆記，像資料夾一樣",
        "- 按 ⌘K（或 Ctrl+K）開指令面板，找筆記、跑指令",
        "",
        "## 想改變看法",
        "",
        "同一則筆記可以用白板、表格、看板等不同的檢視來看。",
      ].join("\n"),
    },
    {
      id: todo, tags: [sampleTag],
      title: "今天要做的事",
      markdown: [
        "勾選的行就是任務，會出現在「任務」頁：",
        "",
        "- [ ] 把試用版逛一圈 {task}",
        "- [ ] 寫下第一則自己的筆記 {task}",
        "- [ ] 下載一份備份，看看裡面是什麼 {task}",
        "- [x] 打開 Onden 試用版 {task}",
      ].join("\n"),
    },
    {
      id: reading, tags: [sampleTag, readingTag],
      title: "讀書筆記：作業系統",
      markdown: [
        "## 行程與執行緒",
        "",
        "行程有自己的記憶體空間；同一個行程裡的執行緒共用它。",
        "",
        "## 死結的四個條件",
        "",
        "互斥、持有並等待、不可搶奪、循環等待，四個同時成立才會死結。",
        "",
        "相關：[[快速上手]]",
      ].join("\n"),
    },
    {
      id: where, tags: [sampleTag],
      title: "資料存在哪裡",
      markdown: [
        "試用版把資料放在這個瀏覽器的私有儲存空間，沒有任何伺服器副本。",
        "",
        "- 關掉分頁、重新整理：資料還在",
        "- 清除網站資料、換瀏覽器、換裝置：資料不見",
        "- 想帶走：設定 › 下載備份，之後可匯入完整版的 Onden",
        "",
        "回到 [[歡迎來到 Onden 試用版]]。",
      ].join("\n"),
    },
  ];
  for (const note of notes) {
    await post("/api/nodes", { id: note.id, title: note.title, markdown: note.markdown, tag_ids: note.tags });
  }
  await writeAppState(STATE_KEY, { notes: notes.map((n) => n.id), tags: [sampleTag, readingTag] } satisfies SampleRows);
}

/** Remove the sample notes for good (trash, then purge) and put their tags in the trash: the app never purges a tag
 *  definition ("not_purgeable"), so a tag stays in History's trash, out of every list. Notes the person wrote are not touched. */
export async function clearSampleNotes(fetchLocal: Fetch, origin: string): Promise<number> {
  const rows = await readRows();
  if (!rows) return 0;
  let cleared = 0;
  const attempt = async (id: string, purge: boolean) => {
    try {
      await call(fetchLocal, origin, "DELETE", `/api/nodes/${id}`);
      if (purge) {
        // The trash's own 「永久刪除」: the preview lists what would go, and the purge must name exactly that.
        const { ids } = await call<{ ids: string[] }>(fetchLocal, origin, "GET", `/api/nodes/${id}/purge-preview`);
        await call(fetchLocal, origin, "POST", `/api/nodes/${id}/purge`, { expected_ids: ids });
      }
      cleared++;
    } catch {
      // already gone (the person deleted it): nothing to do
    }
  };
  for (const id of rows.notes) await attempt(id, true);
  for (const id of rows.tags) await attempt(id, false);
  await writeAppState(STATE_KEY, { notes: [], tags: [] } satisfies SampleRows);
  return cleared;
}
