// Feature-audit deepening (2026-10-09, tick 46): DATA-01 — a Notion export.
// Synthetic Notion "Markdown & CSV" export: hash-suffixed names, nested page
// folders, a database CSV (+ its "_all.csv" twin) with per-row pages, URL-encoded
// relative links between pages, and an image in a page folder.
import { test } from "@playwright/test";
import { H, psql as db } from "../fullstack/helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const h = (n: number) => n.toString(16).padStart(32, "a");

test("DATA-01: Notion export", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const R = `Export-${s}`;
  const home = `Home ${s} ${h(1)}`; const child = `Child Page ${s} ${h(2)}`; const dbName = `Tasks DB ${s} ${h(3)}`;
  const files = [
    { path: `${R}/${home}.md`, content: `# Home ${s}\n\nSee [Child Page ${s}](${encodeURIComponent(`Home ${s} ${h(1)}`)}/${encodeURIComponent(`Child Page ${s} ${h(2)}`)}.md) and the [Tasks DB](${encodeURIComponent(dbName)}.csv).\n\n![shot](${encodeURIComponent(`Home ${s} ${h(1)}`)}/shot.png)` },
    { path: `${R}/${home}/${child}.md`, content: `# Child Page ${s}\n\nBack to [Home ${s}](../${encodeURIComponent(home)}.md).\n\nStatus: Draft` },
    { path: `${R}/${home}/shot.png`, base64: PNG },
    { path: `${R}/${dbName}.csv`, content: `Name,Status,Due,Tags\nWrite report ${s},In progress,"October 10, 2026",urgent\nReview ${s},Done,,` },
    { path: `${R}/${dbName}_all.csv`, content: `Name,Status,Due,Tags\nWrite report ${s},In progress,"October 10, 2026",urgent\nReview ${s},Done,,` },
    { path: `${R}/${dbName}/Write report ${s} ${h(4)}.md`, content: `# Write report ${s}\n\nStatus: In progress\n\nBody of the report row ${s}` },
    { path: `${R}/${dbName}/Review ${s} ${h(5)}.md`, content: `# Review ${s}\n\nStatus: Done\n\nreview body ${s}` },
  ];
  try {
    const r = await req.post("/api/import/obsidian", { ...H, data: { files } });
    const j = await r.json().catch(() => ({}));
    out.response = { status: r.status(), imported: j.imported, folders: j.folders, images: j.images_imported, csv: j.csv_rows_imported, collections_imported: j.collections_imported, collection_rows_imported: j.collection_rows_imported, collection_rows_skipped: j.collection_rows_skipped, collection_bodies_attached: j.collection_bodies_attached, unsupported: j.unsupported_files };
    out.titles = db(`select title||' @'||coalesce((select title from content_nodes p where p.id=n.parent_id),'-') from content_nodes n where deleted_at is null and created_at > now() - interval '5 minutes' and (title like '%${s}%' or markdown like '%${s}%' or title like 'Export-${s}%') order by title`).split("\n");
    out.homeMarkdown = db(`select markdown from content_nodes where deleted_at is null and markdown like '# Home ${s}%' limit 1`).split("\n").filter(Boolean);
    out.childMarkdown = db(`select markdown from content_nodes where deleted_at is null and markdown like '# Child Page ${s}%' limit 1`).split("\n").filter(Boolean);
    out.edges = db(`select count(*) from node_edges e join content_nodes n on n.id=e.source_node_id where n.markdown like '# Home ${s}%' or n.markdown like '# Child Page ${s}%'`);
    out.collection = db(`select title||' fields='||coalesce((tag_schema->'fields')::text,'') from content_nodes where node_type='class_tag' and deleted_at is null and title ilike 'tasks%db%' and created_at > now() - interval '5 minutes' limit 2`).slice(0, 400);
    out.rows = db(`select n.title||' attrs='||coalesce((select string_agg(key||'='||value, ',' order by key) from node_attributes a where a.node_id=n.id and key not like '\\_%'),'')||' body='||left(replace(n.markdown,E'\\n',' '),50) from content_nodes n where deleted_at is null and title in ('Write report ${s}','Review ${s}')`).split("\n");
  } finally {
    const ids = db(`select id from content_nodes where created_at > now() - interval '10 minutes' and (title like '%${s}%' or markdown like '%${s}%' or title ilike 'tasks db ${s}%')`).split("\n").filter(Boolean);
    for (const id of ids) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    out.cleaned = ids.length;
    console.log("NOTION " + JSON.stringify(out, null, 2));
  }
});
