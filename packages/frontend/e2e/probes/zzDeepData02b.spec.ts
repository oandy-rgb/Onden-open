// Feature-audit deepening (2026-10-09, tick 51): DATA-02 — batch recovery.
// A 100-file import whose HTTP request is cut off by the client after 1.5 s
// (the server keeps going), then the same source is imported again with
// upsert: every file must exist exactly once and the second run must report
// the first run's files as unchanged. Also: a batch where one file is invalid
// is refused as a whole (nothing half-imported).
import { test, request as pwRequest } from "@playwright/test";
import { BASE, H, psql as db } from "../fullstack/helpers";


test("DATA-02: interrupted batch then re-import", async ({ page }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const source = { id: `33333333-3333-4333-8333-${String(s).slice(-12).padStart(12, "0")}`, name: `D02b ${s}` };
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `d02b-${s}/f${i % 5}/n${i}.md`, content: `# N${i}\n\nbody ${i} ${s}` }));
  const count = () => Number(db(`select count(*) from content_nodes where deleted_at is null and markdown like '%body % ${s}'`));
  const dupes = () => Number(db(`select count(*) from (select markdown from content_nodes where deleted_at is null and markdown like '%body % ${s}' group by markdown having count(*)>1) x`));
  try {
    // 1. Interrupted: short client timeout (the server continues).
    const short = await pwRequest.newContext({ baseURL: BASE, storageState: test.info().project.use.storageState as string });
    const r1 = await short.post("/api/import/obsidian", { ...H, data: { files, source, upsert: true }, timeout: 1500 }).then((r) => `status ${r.status()}`).catch((e) => `client error: ${String(e).split("\n")[0].slice(0, 80)}`);
    await short.dispose();
    out.firstRun = r1;
    out.countRightAfter = count();
    if (process.env.RETRY_NOW === "1") {
      // Immediate retry while the first run is still being processed.
      const r2now = await (await req.post("/api/import/obsidian", { ...H, data: { files, source, upsert: true }, timeout: 300_000 })).json().catch((e) => ({ error: String(e).slice(0, 80) }));
      out.immediateRetry = { imported: r2now.imported, unchanged: r2now.unchanged, skipped: r2now.skipped, conflicts: (r2now.conflicts ?? []).map((c: { reason?: string }) => c.reason).slice(0, 3), error: r2now.error };
    }
    await page.waitForTimeout(15_000);
    out.countAfterServerFinished = count();
    // 2. Re-import the same source.
    const r2 = await (await req.post("/api/import/obsidian", { ...H, data: { files, source, upsert: true }, timeout: 300_000 })).json();
    out.secondRun = { imported: r2.imported, unchanged: r2.unchanged, updated: r2.updated, skipped: r2.skipped, conflicts: (r2.conflicts ?? []).length, folders: r2.folders, folders_reused: r2.folders_reused };
    out.final = { notes: count(), duplicates: dupes(), folders: db(`select count(*) from content_nodes where deleted_at is null and title in ('f0','f1','f2','f3','f4') and parent_id in (select id from content_nodes where title='d02b-${s}')`) };
    // 3. One invalid file in a batch → whole batch refused.
    const bad = [...files.slice(0, 3).map((f) => ({ ...f, path: f.path.replace(`d02b-${s}`, `d02c-${s}`), content: f.content + " c" })), { path: "../escape.md", content: "x" }];
    const r3 = await req.post("/api/import/obsidian", { ...H, data: { files: bad, source, upsert: true } });
    out.mixedBatch = { status: r3.status(), created: db(`select count(*) from content_nodes where deleted_at is null and title='d02c-${s}'`) };
  } finally {
    const ids = db(`select id from content_nodes where created_at > now() - interval '20 minutes' and (markdown like '%${s}%' or title in ('d02b-${s}','d02c-${s}') or (title ~ '^f[0-4]$' and created_at > now() - interval '20 minutes'))`).split("\n").filter(Boolean);
    for (const id of ids) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    out.cleaned = ids.length;
    console.log("DATA02B " + JSON.stringify(out, null, 2));
  }
});
