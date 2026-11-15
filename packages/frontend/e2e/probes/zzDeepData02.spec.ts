// Feature-audit deepening (2026-10-09, tick 41): DATA-02 — re-importing one
// source (fixed source id, upsert): unchanged re-import, rename, move, a local
// edit then a changed file (conflict), CSV twice, files missing from a later run.
import { test } from "@playwright/test";
import { H, psql as db } from "../fullstack/helpers";


test("DATA-02: re-import identity", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const source = { id: `22222222-2222-4222-8222-${String(s).slice(-12).padStart(12, "0")}`, name: `D02 ${s}` };
  const R = `d02-${s}`;
  const imp = async (files: unknown[], upsert = true) => { const r = await req.post("/api/import/obsidian", { ...H, data: { files, source, upsert } }); const j = await r.json().catch(() => ({})); return { status: r.status(), imported: j.imported, updated: j.updated, unchanged: j.unchanged, skipped: j.skipped, conflicts: (j.conflicts ?? []).map((c: { path?: string; reason?: string }) => `${c.path}:${c.reason}`), csv: j.csv_rows_imported, folders: j.folders, folders_reused: j.folders_reused, err: j.error }; };
  const notes = () => db(`select string_agg(title||'@'||coalesce((select title from content_nodes p where p.id=n.parent_id),'-')||':'||left(replace(markdown,E'\\n',' '),24), ' | ' order by title) from content_nodes n where deleted_at is null and markdown like '%${s}%' and node_type='content'`);
  const csv = `name,score\nalpha ${s},1\nbeta ${s},2\n`;
  const base = [
    { path: `${R}/a.md`, content: `# A\n\nalpha body ${s}` },
    { path: `${R}/b.md`, content: `# B\n\nbeta body ${s}` },
    { path: `${R}/data.csv`, content: csv },
  ];
  try {
    out.first = await imp(base); out.afterFirst = notes();
    out.unchanged = await imp(base); out.afterUnchanged = notes();
    // Rename a.md → a2.md (same content)
    out.rename = await imp([{ path: `${R}/a2.md`, content: `# A\n\nalpha body ${s}` }, base[1]]); out.afterRename = notes();
    // Move b.md → sub/b.md
    out.move = await imp([{ path: `${R}/sub/b.md`, content: `# B\n\nbeta body ${s}` }]); out.afterMove = notes();
    // Local edit of a.md's note, then a changed file → conflict expected
    const aId = db(`select id from content_nodes where deleted_at is null and markdown like '%alpha body ${s}%' and title='a' limit 1`);
    await req.patch(`/api/nodes/${aId}`, { ...H, data: { markdown: `# A\n\nalpha body ${s}\n\nLOCAL EDIT` } });
    out.conflict = await imp([{ path: `${R}/a.md`, content: `# A\n\nalpha body ${s}\n\nFILE CHANGE` }]);
    out.afterConflict = db(`select markdown from content_nodes where id='${aId}'`).replace(/\n/g, "⏎");
    // CSV again
    out.csvAgain = await imp([base[2]]);
    out.csvRows = db(`select count(*) from content_nodes where deleted_at is null and title in ('alpha ${s}','beta ${s}')`);
    // Missing files: import only a2.md; others must stay
    out.partial = await imp([{ path: `${R}/a2.md`, content: `# A\n\nalpha body ${s}` }]); out.afterPartial = notes();
    // Without source but upsert → refused before writing
    const r = await req.post("/api/import/obsidian", { ...H, data: { files: [base[0]], upsert: true } }); out.upsertNoSource = `${r.status()} ${(await r.text()).slice(0, 120)}`;
  } finally {
    const ids = db(`select id from content_nodes where created_at > now() - interval '20 minutes' and (markdown like '%${s}%' or title like '%${s}%' or title in ('${R}','sub','data'))`).split("\n").filter(Boolean);
    for (const id of ids) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    out.cleaned = ids.length;
    console.log("DATA02 " + JSON.stringify(out, null, 2));
  }
});
