// Random sync e2e — the REAL app (syncEngine + localDbWorker: sql.js, IndexedDB /
// OPFS, navigator.locks, several tabs on one storage) under a random sequence of
// edits, offline spells, reloads and closed tabs. The Node-level simulators
// (backend syncSimulator, frontend saveTiming.property) fake the client, the
// network or the clock; this one fakes nothing but the cable (CDP, one tab).
//
// Cast: device A = one browser context with TWO tabs (A1, A2: one shared
// IndexedDB, like the installed PWA plus a browser tab); device B = a second,
// independent context. Same account, so the same notes.
//
// Operations (each picks a tab): type a unique token line · delete a token line
// this tab typed · rename · create a note (quick capture) · delete a note ·
// press Undo on the delete toast · one tab offline / online · reload · close the
// tab and open it again.
//
// After each round (all online, sync settled by waiting on state):
//   1 every token typed and not deleted on purpose is in the server body of its
//     note, in a BODY_CONFLICT of that note, or in a recovery copy (saveTiming #1)
//   2 no deleted-on-purpose token is back (unless in a BODY_CONFLICT region), no
//     token is in a body twice (saveTiming #2)
//   3 a note deleted online and not undone is gone on the server and in every tab
//   4 every tab's sidebar titles and its open note's title/body equal the server
//   5 the same after each tab was reloaded (cold start)
//
// KNOWN OPEN ISSUES — recognised, written to test.info().annotations, not failed:
//   - "rename-in-editor": a rename from the other device that arrives while this
//     tab has the note open and typed in never reaches the editor's title field
//     (saveTiming #4, `stillOpen`). Recognised only when the sidebar and the
//     server agree and the stale title is the editor's alone, and gone after a
//     reload.
//   - "lost-response-resend": a write the server applied whose response was lost
//     is resent and treated as a refusal, so a recovery card holds text the
//     server already has (syncSimulator). Recognised when every token in such a
//     card is already in the server body: nothing is lost, the card is noise.
//
// Opt-in (@faults). Defaults: 3 rounds x 25 operations.
//   E2E_RANDOM_SEED=<n>        replay a whole run (rounds are generated from it)
//   E2E_RANDOM_RUNS=<n> E2E_RANDOM_OPS=<n>
//   E2E_RANDOM_REPLAY='[{"kind":"type","slot":"A1","r":1234}, ...]'
//        one round with exactly these operations (the list a failure prints)
// Run:  packages/frontend/e2e/fullstack/run.sh fullstack/faults/randomSync.spec.ts --grep @faults
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { H, fillWhenReady, openQuickCapture, ready, reloadColdStart, saveQuickCapture } from "../helpers";
import {
  BASE, FAULTS_TAG, editor, openNote, offlineIndicator, setPageOffline, skipUnlessRequested,
} from "./faultKit";
import {
  type Op, type Slot, TOKEN_RE, bodyLines, describeRandomSyncStep, generateOps, occurrences, parseReplay, tokenFor,
} from "./randomSyncKit";

test.beforeEach(skipUnlessRequested);

const SEED = process.env.E2E_RANDOM_SEED ? Number(process.env.E2E_RANDOM_SEED) : Math.floor(Math.random() * 2 ** 31);
const RUNS = Number(process.env.E2E_RANDOM_RUNS ?? 3);
const OPS = Number(process.env.E2E_RANDOM_OPS ?? 25);
const REPLAY = process.env.E2E_RANDOM_REPLAY ? parseReplay(process.env.E2E_RANDOM_REPLAY) : null;
const STORAGE = process.env.E2E_STORAGE || "/tmp/pw-auth.json";
const SEED_NOTES = 3;

// eslint-disable-next-line no-console
console.log(`[randomSync] seed=${SEED} runs=${REPLAY ? 1 : RUNS} ops=${REPLAY ? REPLAY.length : OPS} (E2E_RANDOM_SEED=${SEED})`);

type Note = {
  index: number;
  id?: string;
  /** Creation title of a note made by quick capture; how its id is found. */
  createdTitle?: string;
  titles: string[];
  /** Delete ops that ran, in order: `online` = the tab was online when it ran. */
  history: Array<"deleteOnline" | "deleteOffline" | "undo">;
};
type Typed = { token: string; note: Note; slot: Slot; deletedOnPurpose: boolean };
type Tab = { slot: Slot; page: Page; context: BrowserContext; offline: boolean; current: Note | null; lastDelete: Note | null };

class Round {
  notes: Note[] = [];
  typed: Typed[] = [];
  tabs = new Map<Slot, Tab>();
  log: string[] = [];
  /** Tokens ever read out of a tab's recovery panel (panels are minimised so they never cover the page). */
  recoverySeen = new Set<string>();
  recoveryCards: string[] = [];
  private tokenSeq = 0;
  private titleSeq = 0;
  private createSeq = 0;
  private ctxB!: BrowserContext;

  constructor(readonly run: number, private readonly browser: Browser, private readonly ctxA: BrowserContext) {}

  get api() { return this.ctxA.request; }

  // ── setup / teardown ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    const first = await this.ctxA.newPage();
    for (let i = 0; i < SEED_NOTES; i++) {
      const title = `Rnd${this.run}-${SEED}-seed${i}`;
      const res = await this.api.post("/api/nodes", { ...H, data: { title, markdown: `seed ${i}` } });
      expect(res.ok(), `seed note ${i}: ${res.status()}`).toBeTruthy();
      this.notes.push({ index: i, id: (await res.json()).id as string, titles: [title], history: [] });
    }
    this.ctxB = await this.browser.newContext({ storageState: STORAGE, baseURL: BASE, viewport: { width: 1280, height: 800 } });
    const pages: Array<[Slot, BrowserContext, Page]> = [
      ["A1", this.ctxA, first], ["A2", this.ctxA, await this.ctxA.newPage()], ["B", this.ctxB, await this.ctxB.newPage()],
    ];
    for (const [slot, context, page] of pages) {
      await ready(page, "/?view=notes");
      this.tabs.set(slot, { slot, page, context, offline: false, current: null, lastDelete: null });
    }
  }

  async stop(): Promise<void> {
    await this.ctxB?.close().catch(() => {});
  }

  tab(slot: Slot): Tab { return this.tabs.get(slot)!; }
  live(): Note[] { return this.notes.filter((n) => n.id && !this.deletedByModel(n)); }
  /** Deleted and not undone, as far as the ops that ran say (an offline one may still be queued). */
  deletedByModel(n: Note): boolean { return n.history.at(-1)?.startsWith("delete") ?? false; }

  // ── running an op ─────────────────────────────────────────────────────────

  async exec(op: Op): Promise<void> {
    const tab = this.tab(op.slot);
    let detail: string;
    try {
      await tab.page.bringToFront();
      await this.harvestRecovery(tab.page);
      await this.resolveIds();
      detail = await this.perform(op, tab);
    } catch (error) {
      this.log.push(describeRandomSyncStep(op, `${op.kind} 執行時出錯：${String(error).split("\n")[0]}`));
      throw error;
    }
    this.log.push(describeRandomSyncStep(op, detail));
  }

  private pickNote(tab: Tab, op: Op): Note | null {
    const live = this.live();
    if (tab.offline) return tab.current && live.includes(tab.current) ? tab.current : null; // offline: cannot navigate
    if (tab.current && live.includes(tab.current) && op.r % 4 !== 0) return tab.current;
    return live.length ? live[op.r % live.length]! : null;
  }

  private async showNote(tab: Tab, note: Note): Promise<void> {
    if (tab.current === note) {
      await expect(editor(tab.page)).toBeVisible();
      return;
    }
    await openNote(tab.page, note.id!);
    tab.current = note;
  }

  private async perform(op: Op, tab: Tab): Promise<string> {
    const { page } = tab;
    switch (op.kind) {
      case "type": {
        const note = this.pickNote(tab, op);
        if (!note) return "想打字，但目前沒有可用的筆記（略過）";
        await this.showNote(tab, note);
        const token = tokenFor(this.run, ++this.tokenSeq);
        await expect(async () => {
          await editor(page).click();
          await page.keyboard.press("ControlOrMeta+End");
          await page.keyboard.press("Enter");
          await page.keyboard.type(token);
          await expect(editor(page)).toContainText(token, { timeout: 1_000 });
        }).toPass({ timeout: 20_000 });
        this.typed.push({ token, note, slot: op.slot, deletedOnPurpose: false });
        return `在筆記「${this.label(note)}」打了一行 ${token}${tab.offline ? "（離線中）" : ""}`;
      }
      case "deleteToken": {
        const note = tab.current && this.live().includes(tab.current) ? tab.current : null;
        const own = this.typed.filter((t) => t.slot === op.slot && t.note === note && !t.deletedOnPurpose);
        if (!note || !own.length) return "想刪掉自己打過的一行，但這個分頁目前沒有（略過）";
        const body = await editor(page).innerText();
        const present = own.filter((t) => body.includes(t.token));
        if (!present.length) return "想刪掉自己打過的一行，但編輯器裡已看不到（略過）";
        const target = present[op.r % present.length]!;
        await expect(async () => {
          const line = page.locator(".cm-line", { hasText: target.token }).first();
          await line.click();
          await page.keyboard.press("End");
          await page.keyboard.press("Shift+Home");
          await page.keyboard.press("Backspace");
          await page.keyboard.press("Backspace");
          await expect(editor(page)).not.toContainText(target.token, { timeout: 1_000 });
        }).toPass({ timeout: 20_000 });
        target.deletedOnPurpose = true;
        return `刻意刪掉筆記「${this.label(note)}」裡自己打過的 ${target.token}${tab.offline ? "（離線中）" : ""}`;
      }
      case "rename": {
        const note = this.pickNote(tab, op);
        if (!note) return "想改標題，但目前沒有可用的筆記（略過）";
        await this.showNote(tab, note);
        const title = `Rnd${this.run}-${SEED}-t${++this.titleSeq}`;
        await fillWhenReady(page.locator(".obsidian-title-input"), title);
        note.titles.push(title);
        return `把筆記「${this.label(note)}」改名為「${title}」${tab.offline ? "（離線中）" : ""}`;
      }
      case "create": {
        const title = `Rnd${this.run}-${SEED}-new${++this.createSeq}`;
        await openQuickCapture(page);
        await page.locator(".quick-capture-textarea").fill(title);
        await saveQuickCapture(page); // saving keeps the box open for the next thought (2c7682d5b): the helper waits for "Saved" and closes it
        this.notes.push({ index: this.notes.length, createdTitle: title, titles: [title], history: [] });
        tab.current = null; // the app may have opened it; not worth assuming
        return `用快速記錄建立新筆記「${title}」${tab.offline ? "（離線中，先排進佇列）" : ""}`;
      }
      case "delete": {
        const note = this.pickNote(tab, op);
        if (!note) return "想刪除筆記，但目前沒有可用的筆記（略過）";
        await this.showNote(tab, note);
        await page.locator(".note-actions-more-btn").click();
        await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
        note.history.push(tab.offline ? "deleteOffline" : "deleteOnline");
        tab.current = null;
        tab.lastDelete = note;
        return `刪除筆記「${this.label(note)}」${tab.offline ? "（離線中）" : ""}`;
      }
      case "undoDelete": {
        const note = tab.lastDelete;
        const undo = page.locator(".toast-action");
        if (!note || !(await undo.isVisible().catch(() => false))) return "想按復原，但刪除的提示已經消失（筆記維持刪除）";
        await undo.click();
        note.history.push("undo");
        tab.lastDelete = null;
        return `按下「復原」，救回筆記「${this.label(note)}」`;
      }
      case "offline":
        if (tab.offline) return "想離線，但本來就是離線（略過）";
        await setPageOffline(page, true);
        await expect(offlineIndicator(page)).toBeVisible();
        tab.offline = true;
        return "這個分頁斷線（只切這一個分頁）";
      case "online":
        if (!tab.offline) return "想上線，但本來就是上線（略過）";
        await setPageOffline(page, false);
        tab.offline = false;
        return "這個分頁恢復連線";
      case "reload":
        if (tab.offline) return "想重新整理，但離線時 App 開不起來（略過）";
        await reloadColdStart(page);
        return "重新整理頁面（冷啟動）";
      case "closeReopen": {
        if (tab.offline) {
          // A closed offline tab keeps its queue in storage; the reopened one has a fresh connection.
          this.log.push(describeRandomSyncStep(op, "離線中關閉分頁（排隊中的修改留在本機）"));
        }
        await page.close({ runBeforeUnload: true });
        const next = await tab.context.newPage();
        await ready(next, "/?view=notes");
        tab.page = next;
        tab.offline = false;
        tab.current = null;
        tab.lastDelete = null;
        return "關閉分頁後重新打開（回到列表）";
      }
    }
  }

  private label(note: Note): string { return note.titles.at(-1)!; }

  // ── reading state ─────────────────────────────────────────────────────────

  /** Find the ids of notes made by quick capture once the server has them. */
  async resolveIds(): Promise<void> {
    const open = this.notes.filter((n) => !n.id);
    if (!open.length) return;
    const res = await this.api.get("/api/bootstrap?bodies=none");
    if (!res.ok()) return;
    const nodes = (await res.json()).nodes as Array<{ id: string; title: string }>;
    for (const n of open) n.id = nodes.find((x) => x.title === n.createdTitle)?.id;
  }

  async serverNote(id: string): Promise<{ title: string; markdown: string } | null> {
    const res = await this.api.get(`/api/nodes/${id}`);
    if (res.status() === 404) return null;
    if (!res.ok()) throw new Error(`GET /api/nodes/${id}: ${res.status()}`);
    const row = await res.json();
    return { title: row.title as string, markdown: (row.markdown as string | undefined) ?? "" };
  }

  async conflictText(id: string): Promise<string> {
    const res = await this.api.get(`/api/events?event_type=BODY_CONFLICT&target_id=${id}&limit=500`);
    if (!res.ok()) return "";
    return JSON.stringify((await res.json()).events);
  }

  /** Read the recovery cards of a tab, then minimise the panel so it cannot cover the page. */
  async harvestRecovery(page: Page): Promise<void> {
    const collapsed = page.locator(".fwr-collapsed button");
    if (await collapsed.count()) await collapsed.first().click().catch(() => {});
    const cards = await page.locator(".failed-write-recovery .fwr-content").allInnerTexts().catch(() => []);
    for (const text of cards) {
      if (!this.recoveryCards.includes(text)) this.recoveryCards.push(text);
      for (const t of text.match(TOKEN_RE) ?? []) this.recoverySeen.add(t);
    }
    const minimise = page.locator(".failed-write-recovery .fwr-collapse");
    if (await minimise.count()) await minimise.first().click().catch(() => {});
  }

  // ── settle + invariants ───────────────────────────────────────────────────

  async settle(): Promise<void> {
    for (const tab of this.tabs.values()) {
      if (tab.offline) { await setPageOffline(tab.page, false); tab.offline = false; }
    }
    await expect.poll(async () => { await this.resolveIds(); return this.notes.filter((n) => !n.id).length; },
      { timeout: 60_000, message: "notes created by quick capture must reach the server" }).toBe(0);
    for (const tab of this.tabs.values()) {
      await expect(tab.page.locator(".sync-pending-count"), "queued writes must drain").toHaveCount(0, { timeout: 60_000 });
      // Connected is the quiet state: the sync status sits in the account panel and the avatar shows a badge only for
      // trouble. Offline is the one that means "not connected"; an error badge ("Recovery inputs") is a rejected write kept
      // for the person, which this test's deletes and renames produce on purpose.
      await expect(tab.page.locator(".user-badge--offline"), "back online once settled").toHaveCount(0, { timeout: 60_000 });
    }
    // Quiet = the server's picture of our notes is unchanged over consecutive looks.
    let last = "";
    let steady = 0;
    await expect.poll(async () => {
      const picture = JSON.stringify(await Promise.all(this.notes.map((n) => this.serverNote(n.id!))));
      steady = picture === last ? steady + 1 : 0;
      last = picture;
      return steady;
    }, { timeout: 60_000, intervals: [1_000], message: "server copy must stop changing" }).toBeGreaterThanOrEqual(3);
    for (const tab of this.tabs.values()) await this.harvestRecovery(tab.page);
  }

  async check(): Promise<string[]> {
    const problems: string[] = [];
    const server = new Map<Note, { title: string; markdown: string } | null>();
    for (const n of this.notes) server.set(n, await this.serverNote(n.id!));

    // 3 (server side): deleted online and never undone → gone.
    for (const n of this.notes) {
      const online = n.history.includes("deleteOnline");
      const undone = n.history.includes("undo");
      if (online && !undone && server.get(n)) problems.push(`#3 筆記「${this.label(n)}」在線上刪除、沒有復原，但伺服器上還在`);
      if (!n.history.length && !server.get(n)) problems.push(`#3 筆記「${this.label(n)}」從沒被刪，但伺服器上不見了`);
    }

    // 1 + 2
    const known: string[] = [];
    for (const t of this.typed) {
      const row = server.get(t.note);
      if (!row) continue; // note is gone: its text went with it
      const count = occurrences(row.markdown, t.token);
      const inConflict = (await this.conflictText(t.note.id!)).includes(t.token);
      if (t.deletedOnPurpose) {
        if (count && !inConflict) problems.push(`#2 刻意刪掉的 ${t.token} 又出現在筆記「${this.label(t.note)}」`);
        continue;
      }
      if (count > 1) problems.push(`#2 ${t.token} 在筆記「${this.label(t.note)}」出現 ${count} 次`);
      if (!count && !inConflict && !this.recoverySeen.has(t.token)) {
        problems.push(`#1 ${t.token}（${t.slot} 打的）在筆記「${this.label(t.note)}」不見了：不在內文、衝突區或復原區`);
      }
    }
    // Recovery cards whose tokens the server already holds: the resend-as-refusal noise.
    const noisy = this.recoveryCards.filter((text) => {
      const tokens = text.match(TOKEN_RE) ?? [];
      return tokens.length > 0 && tokens.every((tok) => [...server.values()].some((r) => r?.markdown.includes(tok)));
    });
    if (noisy.length) known.push(`lost-response-resend: ${noisy.length} 張復原卡的內容伺服器其實已有（重送被當成拒絕）`);

    // 4: every tab, as it stands
    for (const tab of this.tabs.values()) problems.push(...await this.checkTab(tab, server, known, "線上"));

    // 5: every tab after a cold start
    for (const tab of this.tabs.values()) {
      await reloadColdStart(tab.page);
      for (const n of this.notes) {
        const row = server.get(n);
        if (!row) continue;
        await openNote(tab.page, n.id!);
        tab.current = n;
        problems.push(...await this.checkOpenNote(tab, row, "重新整理後"));
      }
      problems.push(...await this.checkSidebar(tab, server, "重新整理後"));
    }
    for (const k of known) test.info().annotations.push({ type: "known-issue", description: k });
    return problems;
  }

  /** Sidebar titles equal the server's; the open note's title and body too. */
  async checkTab(tab: Tab, server: Map<Note, { title: string; markdown: string } | null>, known: string[], when: string): Promise<string[]> {
    const problems = await this.checkSidebar(tab, server, when);
    const note = tab.current;
    const row = note && server.get(note);
    if (!note || !row) return problems;
    const found = await this.checkOpenNote(tab, row, when, async (title) => {
      // The editor's title field alone is stale while sidebar and server agree: the known open case.
      if (problems.length === 0) {
        known.push(`rename-in-editor: ${tab.slot} 的編輯器標題停在「${title}」，伺服器與側欄是「${row.title}」（另一台改名沒傳到編輯中的筆記）`);
        return true;
      }
      return false;
    });
    return [...problems, ...found];
  }

  async checkOpenNote(
    tab: Tab, row: { title: string; markdown: string }, when: string,
    excuseTitle?: (shown: string) => Promise<boolean>,
  ): Promise<string[]> {
    const out: string[] = [];
    const title = tab.page.locator(".obsidian-title-input");
    let bodyDiff = "";
    let titleDiff = "";
    try {
      await expect.poll(async () => {
        const [shownBody, shownTitle] = [await editor(tab.page).innerText(), await title.inputValue()];
        bodyDiff = JSON.stringify(bodyLines(shownBody)) === JSON.stringify(bodyLines(row.markdown)) ? "" : shownBody;
        titleDiff = shownTitle === row.title ? "" : shownTitle;
        return bodyDiff === "" && titleDiff === "";
      }, { timeout: 30_000, intervals: [500, 1_000] }).toBe(true);
    } catch { /* classified below */ }
    if (bodyDiff) out.push(`#4 ${when}：${tab.slot} 開著的筆記「${row.title}」內文與伺服器不同。畫面：${JSON.stringify(bodyLines(bodyDiff))}；伺服器：${JSON.stringify(bodyLines(row.markdown))}`);
    if (titleDiff && !(excuseTitle && await excuseTitle(titleDiff))) {
      out.push(`#4 ${when}：${tab.slot} 開著的筆記標題是「${titleDiff}」，伺服器是「${row.title}」`);
    }
    return out;
  }

  async checkSidebar(tab: Tab, server: Map<Note, { title: string; markdown: string } | null>, when: string): Promise<string[]> {
    const out: string[] = [];
    // A note made by quick capture is filed in the Inbox, not the Notes list (2c7682d5b, 2026-10-29): each kind is looked
    // for in its own sidebar pane, and the Notes pane is put back afterwards (later operations read it).
    const pane = (name: "Notes" | "Inbox") => tab.page.locator(".sidebar-tab").filter({ hasText: new RegExp(`^${name}`) });
    const titlesIn = async (name: "Notes" | "Inbox"): Promise<string[]> => {
      await pane(name).click();
      return name === "Inbox"
        ? tab.page.locator(".capture-inbox-item-title").allInnerTexts()
        : tab.page.locator(".obsidian-page-button").allInnerTexts();
    };
    for (const n of this.notes) {
      const row = server.get(n);
      const stale = n.titles.filter((t) => t !== row?.title);
      // Every title the note ever had but the server's current one must be gone; the current one present.
      const want = row ? row.title : null;
      const where = n.createdTitle ? "Inbox" : "Notes";
      try {
        await expect.poll(async () => {
          const shown = await titlesIn(where);
          const has = (t: string) => shown.some((s) => s.includes(t));
          return [...(want && !has(want) ? [`缺「${want}」`] : []), ...stale.filter(has).map((t) => `多「${t}」`)];
        }, { timeout: 30_000, intervals: [500, 1_000] }).toEqual([]);
      } catch {
        const shown = (await titlesIn(where)).filter((s) => s.includes(`Rnd${this.run}-${SEED}`));
        out.push(`#${row ? 4 : 3} ${when}：${tab.slot} ${where === "Inbox" ? "收件匣" : "側欄"}與伺服器不一致（筆記原名「${n.titles[0]}」，伺服器${row ? `標題「${row.title}」` : "已刪除"}）；顯示：${JSON.stringify(shown)}`);
      }
    }
    await pane("Notes").click();
    return out;
  }
}

// ── the tests ─────────────────────────────────────────────────────────────────

function opsFor(run: number): Op[] {
  return REPLAY ?? generateOps(SEED * 1000 + run, OPS);
}

function failureReport(round: Round, ops: Op[], done: number, problems: string[]): string {
  const replay = `E2E_RANDOM_REPLAY='${JSON.stringify(ops.slice(0, done))}'`;
  return [
    "",
    `隨機同步測試失敗：種子 ${SEED}，第 ${round.run + 1} 輪（共 ${REPLAY ? 1 : RUNS} 輪）`,
    "── 到失敗為止的操作 ──",
    ...round.log.map((line, i) => `${String(i + 1).padStart(2)}. ${line}`),
    "── 違反的不變式 ──",
    ...problems,
    "── 重播 ──",
    `整個測試：E2E_RANDOM_SEED=${SEED} E2E_RANDOM_RUNS=${REPLAY ? 1 : RUNS} E2E_RANDOM_OPS=${OPS} packages/frontend/e2e/fullstack/run.sh fullstack/faults/randomSync.spec.ts --grep @faults`,
    `只重播這一串：${replay}`,
    "",
  ].join("\n");
}

for (let run = 0; run < (REPLAY ? 1 : RUNS); run++) {
  test(`random sync round ${run + 1}`, { tag: FAULTS_TAG }, async ({ browser, context }) => {
    test.setTimeout(30 * 60_000);
    const ops = opsFor(run);
    const round = new Round(run, browser, context);
    let done = 0;
    try {
      await round.start();
      for (const op of ops) { await round.exec(op); done++; }
      await round.settle();
      const problems = await round.check();
      expect(problems, failureReport(round, ops, done, problems)).toEqual([]);
    } catch (error) {
      const text = String(error);
      if (!text.includes("隨機同步測試失敗")) {
        // eslint-disable-next-line no-console
        console.error(failureReport(round, ops, done, [`測試本身中斷：${text.split("\n")[0]}`]));
      }
      throw error;
    } finally {
      await round.stop();
    }
  });
}
