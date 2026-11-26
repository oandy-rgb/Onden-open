// Feature-audit deepening (2026-10-08): PDF-03 — freehand on a PDF: commit
// (back to Select) then leave for Tasks / reload within 200 ms (does the 800
// ms debounced save survive?), Escape during a draw session (it keeps what was
// drawn and goes back to Select: docs/agents/decisions-canvas.md), a refused save.
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000101 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
178
%%EOF`,
).toString("base64");

/** Every drawing save a page sends and what the server answered, attached to the report: when a step fails, it tells a save
 *  that never left the page from one the server did not keep (CI's stack and the cloud stack differ: a red that only CI
 *  shows needs this to be read). */
function recordSaves(log: string[], p: Page, label: string): void {
  const started = Date.now();
  p.on("request", (r) => { if (r.method() === "PUT" && /\/attributes\/(ink_data|note_ink|board_ink)$/.test(r.url())) log.push(`${label} +${Date.now() - started}ms sent ${r.url().split("/attributes/")[1]} ${r.postData()?.length ?? 0} chars`); });
  p.on("response", (r) => { if (r.request().method() === "PUT" && /\/attributes\/(ink_data|note_ink|board_ink)$/.test(r.url())) log.push(`${label} +${Date.now() - started}ms answered ${r.status()}`); });
  p.on("requestfailed", (r) => { if (r.method() === "PUT" && /\/attributes\//.test(r.url())) log.push(`${label} +${Date.now() - started}ms failed ${r.failure()?.errorText ?? ""}`); });
  // The page's first boot reads (a new page life after a reload): when its sync, which drains the queue, started.
  const firstOf = new Set<string>();
  p.on("request", (r) => {
    const what = /\/api\/(bootstrap|sync)(\?|$|\/membership\/digest)/.exec(r.url())?.[0];
    if (!what) return;
    const life = `${p.mainFrame().url()}#${what}`;
    if (firstOf.has(life)) return;
    firstOf.add(life);
    log.push(`${label} +${Date.now() - started}ms read ${what.replace("/api/", "")}`);
  });
  p.on("load", () => { firstOf.clear(); log.push(`${label} +${Date.now() - started}ms page loaded`); });
}
/** What this device holds for the note's drawing, read from the page: the queue rows in the local journal
 *  (lib/localDbJournal: a pw.put per row, a pw.del when sent) and the entries a page left in recovery on its way out
 *  (localStorage, taken into the queue by the next page's boot). Tells "not sent yet" from "nothing to send". The rows
 *  already folded into the stored snapshot are not read here (the journal keeps them until a snapshot is saved). */
async function heldOnDevice(p: Page, nodeId: string, { journal: readJournal = true } = {}): Promise<string> {
  return p.evaluate(async ([id, readJournal]) => {
    const want = (path: unknown) => typeof path === "string" && path.includes(`/nodes/${id}/attributes/`);
    const short = (key: unknown) => (typeof key === "string" ? key.slice(0, 8) : "-");
    let journal = readJournal ? "no journal" : "journal not read (held busy)";
    const names = readJournal ? await indexedDB.databases().catch(() => []) : [];
    if (names.some((d) => d.name === "onden-journal")) {
      journal = await new Promise<string>((resolve) => {
        const open = indexedDB.open("onden-journal");
        open.onerror = () => resolve("journal unreadable");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("entries")) { db.close(); resolve("journal empty"); return; }
          const all = db.transaction("entries", "readonly").objectStore("entries").getAll();
          all.onerror = () => { db.close(); resolve("journal unreadable"); };
          all.onsuccess = () => {
            db.close();
            const rows = new Map<string, { path: string; chars: number; base: string; rejected: boolean }>();
            let puts = 0;
            for (const e of all.result as Array<{ op: { t: string; row?: { path: string; body: string | null; idem_key: string | null; rejection: string | null }; idem_key?: string | null } }>) {
              if (e.op.t === "pw.put" && e.op.row && want(e.op.row.path)) {
                puts += 1;
                let base = "?";
                try { const b = JSON.parse(e.op.row.body ?? "{}") as { base_value?: string | null }; base = b.base_value === "" ? "from nothing" : b.base_value == null ? "no base" : `base ${b.base_value.length} chars`; } catch { /* patch body */ }
                rows.set(e.op.row.idem_key ?? "", { path: e.op.row.path.split("/attributes/")[1] ?? "", chars: e.op.row.body?.length ?? 0, base, rejected: !!e.op.row.rejection });
              } else if (e.op.t === "pw.del") rows.delete(e.op.idem_key ?? "");
            }
            const live = [...rows.entries()].map(([k, r]) => `${short(k)} ${r.path} ${r.chars} chars ${r.base}${r.rejected ? " refused" : ""}`);
            resolve(`journal: ${live.length} row(s) still queued for this note${live.length ? ` (${live.join("; ")})` : ""}, ${puts} record(s) written for it`);
          };
        };
      });
    }
    let left = 0, copied = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? "";
      if (key.includes("lostWrites")) {
        try { left += (JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ path?: string; rejection?: string }>).filter((w) => want(w.path) && !w.rejection).length; } catch { /* not ours */ }
      } else if (key.includes("keptWrites")) {
        // Strokes copied at pen-up whose queue row was not written yet (writeQueue keepUnsentWrite, one entry per row key):
        // the next page queues them.
        try { if (want((JSON.parse(localStorage.getItem(key) ?? "{}") as { path?: string }).path)) copied += 1; } catch { /* not ours */ }
      }
    }
    return `${journal}; left in recovery: ${left}; copied at pen-up: ${copied}`;
  }, [nodeId, readJournal] as const).catch((error: unknown) => `could not read the device: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}

/** Holds the device's write journal busy (a readwrite transaction on its store, kept open by chained reads) until the page
 *  goes away or `ms` pass: no queue row can be written meanwhile, as on CI, where 155 ms after Select the second stroke's
 *  row was still not written (the worker busy with a large workspace's sync). Whatever the person drew in that time must
 *  already be somewhere that outlives the page. Resolves once the transaction holds the store; false if it could not. */
async function stallJournal(p: Page, ms: number): Promise<boolean> {
  return p.evaluate((ms) => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("onden-journal");
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("entries")) { db.close(); resolve(false); return; }
      const tx = db.transaction("entries", "readwrite");
      const store = tx.objectStore("entries");
      const until = Date.now() + ms;
      const spin = () => { if (Date.now() < until) store.count().onsuccess = spin; };
      store.count().onsuccess = () => { resolve(true); spin(); };
      tx.oncomplete = tx.onabort = () => db.close();
    };
  }), ms);
}

/** The browser's renderer processes (their pids), from Chromium's own process list. */
async function rendererPids(browser: Browser): Promise<Set<number>> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo") as { processInfo: Array<{ type: string; id: number }> };
    return new Set(processInfo.filter((p) => p.type === "renderer").map((p) => p.id));
  } finally { await cdp.detach().catch(() => {}); }
}

/** A failing step carries the saves in its own message (and stdout): CI keeps the error, not the attachments. */
async function withSaves(log: string[], run: () => Promise<void>): Promise<void> {
  try { await run(); }
  catch (error) {
    const saves = `── drawing saves ──\n${log.join("\n") || "(none)"}`;
    console.log(saves);
    if (error instanceof Error) error.message = `${error.message}\n${saves}`;
    throw error;
  }
}

test("PDF-03: ink save timing, Escape, refusal", async ({ page }) => {
  test.setTimeout(300_000);
  const saves: string[] = [];
  recordSaves(saves, page, "page");
  await withSaves(saves, () => pdf03(page, saves));
});

async function pdf03(page: Page, saves: string[]) {
  const inkGroups = async (id: string) => { const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json(); const list = Array.isArray(at) ? at : at.attributes ?? []; const raw = list.find((a: { key: string }) => a.key === "ink_data")?.value; if (!raw) return 0; try { return JSON.parse(raw).pages?.["1"]?.strokes.length ?? 0; } catch { return -1; } };
  const newPdf = async () => {
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `Pdf3 ${Date.now()}`, markdown: "" } })).json();
    await page.request.put(`/api/nodes/${node.id}/attributes/pdf_url`, { ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" } });
    await ready(page, `/?view=notes&node=${node.id}`);
    await expect(page.locator(".pdf-node-content [data-page-key], .pdf-node-content canvas").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    return node.id as string;
  };
  const draw = async (p: Page, dy = 0, commit = true) => {
    const pen = p.locator('[data-ink-tool="pen"]');
    await pen.click();
    await expect(pen, "the pen is the tool before the stroke is drawn").toHaveAttribute("aria-pressed", "true");
    const b = (await p.locator(".pdf-node-content").boundingBox())!; const cx = b.x + b.width / 2, cy = b.y + b.height / 3 + dy;
    await p.mouse.move(cx - 80, cy); await p.mouse.down(); for (const [x, y] of [[cx - 20, cy + 15], [cx + 60, cy - 10]]) await p.mouse.move(x, y, { steps: 6 }); await p.mouse.up();
    if (commit) await p.locator('[data-pdf-tool="select"]').click();
  };
  let id = await newPdf();
  await draw(page);
  // A stroke drawn and committed is saved (after the debounce): one stroke on page 1.
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(1);
  // A second stroke, then leaving for Tasks within 200 ms: the debounced save must survive the leave
  // (decisions-canvas.md: 進行中寫入由 writeLifecycle 登記 protectPendingWriteOnExit; the page's own leave commits the draw session first).
  await draw(page, 60);
  // Both strokes are on the page (Select shows them as the page's picture) before the leave: a red below is then a save
  // that did not happen, not a stroke that was never drawn (CI: the second save never left the page; review of #1958).
  await expect(page.locator(".page-ink-svg path"), "the second stroke is drawn before the leave").toHaveCount(2);
  await page.waitForTimeout(200); // the leave is the action under test: it must come before the save's debounce ends
  await page.locator(".app-primary-nav").getByRole("button", { name: "Tasks", exact: true }).click();
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(2);
  // The same with a reload within 200 ms.
  id = await newPdf();
  await draw(page); await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(1);
  await draw(page, 60);
  await expect(page.locator(".page-ink-svg path"), "the second stroke is drawn before the reload").toHaveCount(2);
  // What the device holds just before the reload (read at ~150 ms, the reload still at 200 ms): was the stroke's row
  // durable by then? And right after the page is back, and again if the poll fails: "not sent yet" or "nothing to send".
  const leftAt = Date.now();
  await page.waitForTimeout(150);
  const before = await heldOnDevice(page, id);
  saves.push(`before reload (${Date.now() - leftAt} ms after Select): ${before}`);
  await page.waitForTimeout(Math.max(0, 200 - (Date.now() - leftAt)));
  await page.reload();
  saves.push(`after reload: ${await heldOnDevice(page, id)}`);
  try { await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(2); }
  catch (error) { saves.push(`15 s after reload: ${await heldOnDevice(page, id)}`); throw error; }
  // Escape during a draw session goes back to Select and keeps what was drawn, saved
  // (decisions-canvas.md: 「Esc 回選取並保留已畫的」; decisions-canvas-history.md: 「Esc 回選取（同樣先存）」).
  id = await newPdf();
  await draw(page, 0, false);
  await page.keyboard.press("Escape");
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(1);
  await expect(page.locator(".page-ink-svg path"), "the stroke stays on the page").toHaveCount(1);
  await expect(page.locator('[data-pdf-tool="select"]'), "Escape went back to Select").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".toast"), "Escape keeps the stroke without a notice").toHaveCount(0); // pinned: today's behaviour, no written rule
  // A refused save (403): the server keeps what it had, the stroke stays on the page, and the refused input is kept in the recovery panel
  // (decisions-offline-account.md, batch 16: a refusal is not a discard; 403 reads 「You don't have permission to do that.」).
  await page.route(`**/api/nodes/${id}/attributes/**`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await draw(page);
  const recovery = page.locator(".failed-write-recovery").filter({ visible: true });
  await expect(recovery).toContainText("This change was rejected");
  await expect(recovery).toContainText("You don't have permission to do that.");
  expect(await inkGroups(id), "the server still has one stroke").toBe(1);
  await expect(page.locator(".page-ink-svg path"), "both strokes stay on the page").toHaveCount(2);
  await expect(page.locator(".toast"), "the refusal is reported once, in the recovery panel, not also as a toast").toHaveCount(0); // pinned: today's behaviour, no written rule
  await page.unroute(`**/api/nodes/${id}/attributes/**`);
}

// A finished stroke is kept on this device from pen-up (docs/architecture/note-writes.md「筆跡：抬筆就記下」): the page
// dying with no event at all, reloading, or closing with no connection, before the surface's pause has sent it, leaves it
// on the server or in the queue the next page sends. Every ink surface keeps it the same way (lib/ink/surfaceSaver
// keepAdded); each is checked here: a PDF page, a handwriting note, a note's 手寫 tab, a whiteboard's pen layer. Before
// this rule a renderer killed 150 ms after pen-up lost the stroke.
type Surface = {
  name: string;
  attr: "ink_data" | "note_ink" | "board_ink";
  /** Make the note and open it, ready to draw; returns its id. */
  open: (p: Page) => Promise<string>;
  /** The element strokes are drawn on. */
  area: (p: Page) => ReturnType<Page["locator"]>;
  /** Strokes in what the server stores (first page / page 1). */
  strokes: (raw: string) => number;
};
const blankPage = JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } });
const SURFACES: Surface[] = [
  {
    name: "PDF page", attr: "ink_data",
    open: async (p) => {
      const node = await (await p.request.post("/api/nodes", { ...H, data: { title: `Pdf3 kill ${Date.now()}`, markdown: "" } })).json();
      await p.request.put(`/api/nodes/${node.id}/attributes/pdf_url`, { ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" } });
      await ready(p, `/?view=notes&node=${node.id}`);
      await expect(p.locator(".pdf-node-content [data-page-key], .pdf-node-content canvas").first()).toBeVisible({ timeout: 20_000 });
      return node.id as string;
    },
    area: (p) => p.locator(".pdf-node-content").first(),
    strokes: (raw) => JSON.parse(raw).pages?.["1"]?.strokes.length ?? 0,
  },
  {
    name: "handwriting note", attr: "ink_data",
    open: async (p) => {
      const node = await (await p.request.post("/api/nodes", { ...H, data: { title: `Pdf3 kill ${Date.now()}`, markdown: "" } })).json();
      await p.request.put(`/api/nodes/${node.id}/attributes/ink_data`, { ...H, data: { value: blankPage, value_type: "text" } });
      await ready(p, `/?view=notes&node=${node.id}`);
      await expect(p.locator(".ink-note .pagebook-page").first()).toBeVisible({ timeout: 20_000 });
      return node.id as string;
    },
    area: (p) => p.locator(".ink-note .pagebook-page").first(),
    strokes: (raw) => JSON.parse(raw).strokes?.length ?? 0,
  },
  {
    name: "a note's 手寫 tab", attr: "note_ink",
    open: async (p) => {
      const node = await (await p.request.post("/api/nodes", { ...H, data: { title: `Pdf3 kill ${Date.now()}`, markdown: "" } })).json();
      expect((await p.request.post(`/api/nodes/${node.id}/views`, { ...H, data: { name: "Handwriting", layout: "handwriting" } })).ok()).toBeTruthy();
      await ready(p, `/?view=notes&node=${node.id}`);
      await p.getByRole("tab", { name: /Handwriting|手寫/ }).first().click();
      await expect(p.locator(".handwriting-pane .pagebook-page").first()).toBeVisible({ timeout: 20_000 });
      return node.id as string;
    },
    area: (p) => p.locator(".handwriting-pane .pagebook-page").first(),
    strokes: (raw) => JSON.parse(raw).strokes?.length ?? 0,
  },
  {
    name: "whiteboard pen layer", attr: "board_ink",
    open: async (p) => {
      const canvas = await (await p.request.post("/api/canvases", { ...H, data: { title: `Pdf3 kill ${Date.now()}` } })).json();
      await ready(p, `/?view=notes&node=${canvas.id}`);
      // P turns the pen on once the board knows its id (inkCanvas.spec.ts pressPen).
      const toolbar = p.locator(".canvas-ink-toolbar");
      await expect(async () => {
        if (!(await toolbar.isVisible().catch(() => false))) await p.keyboard.press("p");
        await expect(toolbar).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await expect(p.locator(".canvas-ink-layer")).toBeVisible();
      return canvas.id as string;
    },
    area: (p) => p.locator(".canvas-ink-layer").first(),
    strokes: (raw) => JSON.parse(raw).strokes?.length ?? 0,
  },
];

test("PDF-03: a stroke survives the page being killed, reloaded or closed offline right after pen-up", async ({ page, context, browser }) => {
  test.setTimeout(720_000);
  const saves: string[] = [];
  await withSaves(saves, () => survives(page, context, browser, saves));
});

async function survives(page: Page, context: BrowserContext, browser: Browser, saves: string[]) {
  const strokesOn = async (s: Surface, id: string) => {
    const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json();
    const list = Array.isArray(at) ? at : at.attributes ?? [];
    const raw = list.find((a: { key: string }) => a.key === s.attr)?.value;
    if (!raw) return 0;
    try { return s.strokes(raw); } catch { return -1; }
  };
  const open = async (p: Page, s: Surface) => { const id = await s.open(p); await p.waitForTimeout(800); return id; };
  // Pen up, no Select, no pause: the stroke is only with the saver (each surface waits about a second before its save).
  const stroke = async (p: Page, s: Surface, dy = 0) => {
    const pen = p.locator('[data-ink-tool="pen"]').first();
    if (s.attr !== "board_ink" && (await pen.getAttribute("aria-pressed")) !== "true") await pen.click();
    const b = (await s.area(p).boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + Math.min(b.height / 3, 300) + dy;
    await p.mouse.move(cx - 80, cy); await p.mouse.down(); for (const [x, y] of [[cx - 20, cy + 15], [cx + 60, cy - 10]]) await p.mouse.move(x, y, { steps: 6 }); await p.mouse.up();
  };
  // Killed: the renderer dies 150 ms after pen-up, no pagehide, no visibilitychange (a phone reclaiming the tab). In a
  // context of its own (the same disk for the page that opens next); a context that saw a crash no longer goes offline.
  // `stalled`: the device's write journal is held busy from before the stroke, so its queue row cannot be written before
  // the kill (CI: 155 ms after Select the row was still not written). The stroke must be handed over in the pen-up handler
  // itself; nothing on the way out (there is no way out here) and no write that has not happened yet may be needed.
  const killedAfterPenUp = async (s: Surface, stalled: boolean) => {
    const label = `${s.name} killed${stalled ? " (journal busy)" : ""}`;
    const crashed = await browser.newContext({ storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
    const before = await rendererPids(browser);
    let victim = await crashed.newPage();
    recordSaves(saves, victim, label);
    const id = await open(victim, s);
    if (stalled) expect(await stallJournal(victim, 10_000), `${label}: the device's journal could be held busy`).toBe(true);
    await stroke(victim, s); await victim.waitForTimeout(150);
    if (stalled) saves.push(`${label}, before the kill: ${await heldOnDevice(victim, id, { journal: false })}`);
    // The page's renderer process is killed (SIGKILL: no unload handler, no pagehide, nothing runs), as a phone reclaiming
    // the tab does; the test goes on only once the browser says the page crashed, and it is closed. On
    // CI's Chromium neither chrome://crash nor CDP Page.crash killed it reliably, and opening the next page while it was
    // dying raced its load (net::ERR_ABORTED).
    // Only the page's own renderer: the new renderers are killed one at a time, oldest first, until the browser says the
    // page crashed. Killing every new renderer can also take the spare one Chromium keeps for the next page; when every
    // one was killed, the next page once in 10 runs here never finished loading (a likely cause, not a proven one).
    const mine = [...await rendererPids(browser)].filter((pid) => !before.has(pid)).sort((a, b) => a - b);
    expect(mine.length, `${label}: the page has a renderer process of its own`).toBeGreaterThan(0);
    let dead = false;
    victim.once("crash", () => { dead = true; }); // the browser's own word that the renderer is gone
    const killed: number[] = [];
    for (const pid of mine) {
      try { process.kill(pid, "SIGKILL"); killed.push(pid); } catch { /* already gone */ }
      await expect.poll(() => dead, { timeout: 3_000 }).toBe(true).catch(() => {});
      if (dead) break;
    }
    saves.push(`${label}: killed ${killed.length} of ${mine.length} new renderer(s)`);
    expect(dead, `${label}: the page was killed (renderers new since it opened: ${mine.length}, killed: ${killed.length})`).toBe(true);
    await victim.close().catch(() => {});
    victim = await crashed.newPage();
    recordSaves(saves, victim, `${label}, next page`);
    await ready(victim, "/?view=tasks"); // the next page sends what the killed one kept
    saves.push(`${label}, next page: ${await heldOnDevice(victim, id)}`);
    await expect.poll(() => strokesOn(s, id), { timeout: 20_000, message: `${label}: the stroke survives the page being killed` }).toBe(1);
    await crashed.close();
  };
  for (const s of SURFACES) {
    await killedAfterPenUp(s, false);
    let victim: Page;
    let id: string;
    // Reloaded 100 ms after pen-up, without Select: the strokes are on the server once each, not twice.
    victim = await context.newPage();
    recordSaves(saves, victim, `${s.name} reload`);
    id = await open(victim, s);
    await stroke(victim, s); await stroke(victim, s, 60); await victim.waitForTimeout(100);
    await victim.reload();
    await expect.poll(() => strokesOn(s, id), { timeout: 20_000, message: `${s.name}: two strokes then reload` }).toBe(2);
    await expect.poll(() => strokesOn(s, id), { timeout: 3_000 }).not.toBe(2).catch(() => {}); // nothing more arrives
    expect(await strokesOn(s, id), `${s.name}: no stroke is stored twice`).toBe(2);
    await victim.close();
    // Closed with no connection: every request of that page fails (as a dropped network does; context.setOffline is
    // refused once the context has closed pages), so the stroke waits in the queue; the next page sends it.
    victim = await context.newPage();
    recordSaves(saves, victim, `${s.name} no connection`);
    id = await open(victim, s);
    await victim.route("**/api/**", (r) => r.abort("internetdisconnected"));
    await stroke(victim, s); await victim.waitForTimeout(100);
    await victim.close({ runBeforeUnload: true });
    victim = await context.newPage();
    recordSaves(saves, victim, `${s.name} next page`);
    await ready(victim, "/?view=tasks");
    await expect.poll(() => strokesOn(s, id), { timeout: 20_000, message: `${s.name}: a stroke drawn with no connection, then the page closed` }).toBe(1);
    await victim.close();
  }
  // Once more with the journal held busy: every surface hands its strokes over through the same saver
  // (lib/ink/surfaceSaver keepAdded → writeQueue keepUnsentWrite), so one surface shows the hand-off does not wait for storage.
  await killedAfterPenUp(SURFACES[0]!, true);
  void page;
}
