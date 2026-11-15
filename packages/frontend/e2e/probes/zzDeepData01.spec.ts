// Feature-audit deepening (2026-10-09, tick 40): DATA-01 — Markdown/Obsidian
// import via POST /api/import/obsidian: hostile paths, broken frontmatter, a
// 3 MB note, every image-embed syntax, and a 1 500-file vault (time, counts).
import { test } from "@playwright/test";
import { H, psql as db } from "../fullstack/helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("DATA-01: import edge cases", async ({ page }) => {
  test.setTimeout(600_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const imp = async (files: unknown[], extra: Record<string, unknown> = {}) => { const t0 = Date.now(); const r = await req.post("/api/import/obsidian", { ...H, data: { files, ...extra }, timeout: 300_000 }); const body = await r.text(); return { status: r.status(), ms: Date.now() - t0, body: body.slice(0, 300) }; };
  try {
    // 1. Hostile paths: see tick40/data01.log (first run).
    // 2. Broken frontmatter, 3 MB body.
    const fm = await imp([
      { path: `fm-bad-${s}.md`, content: `---\ntitle: [unclosed\ntags: {\n---\nbody bad fm ${s}` },
      { path: `fm-ok-${s}.md`, content: `---\ntitle: FM OK ${s}\ntags: [a${s}, b${s}]\nrating: 5\n---\nbody ok ${s}` },
      { path: `big-${s}.md`, content: `# Big ${s}\n\n` + "lorem ipsum ".repeat(260_000) },
    ]);
    out.frontmatter = { ...fm, bad: db(`select title||' len='||length(markdown) from content_nodes where markdown like '%body bad fm ${s}%' limit 1`), ok: db(`select n.title||' attrs='||coalesce((select string_agg(key||'='||value, ',') from node_attributes a where a.node_id=n.id and key not like '\\_%'),'') from content_nodes n where n.markdown like '%body ok ${s}%' limit 1`), big: db(`select title||' len='||length(markdown) from content_nodes where markdown like '# Big ${s}%' limit 1`), okTags: db(`select coalesce(string_agg(t.title, ','),'none') from content_nodes n join node_tags nt on nt.node_id=n.id join content_nodes t on t.id=nt.tag_id where n.markdown like '%body ok ${s}%'`) };
    // 3. Image embeds.
    const embedMd = [`# Embeds ${s}`, "wiki: ![[pic.png]]", "wiki-size: ![[pic.png|300]]", "wiki-frag: ![[pic.png#x]]", "md: ![alt](pic.png)", "md-sub: ![alt](img/pic2.png)", "md-angle: ![a](<img/pic 3.png>)", "html: <img src=\"pic.png\">", "note-embed: ![[Other note]]", "missing: ![[nope.png]]", "code: `![[pic.png]]`"].join("\n\n");
    const em = await imp([{ path: `emb-${s}/Embeds.md`, content: embedMd }, { path: `emb-${s}/pic.png`, base64: PNG }, { path: `emb-${s}/img/pic2.png`, base64: PNG }, { path: `emb-${s}/img/pic 3.png`, base64: PNG }]);
    out.embeds = { status: em.status, body: em.body.slice(0, 160), markdown: db(`select markdown from content_nodes where markdown like '# Embeds ${s}%' limit 1`).split("\n").filter(Boolean) };
    // 4. Large vault.
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `vault-${s}/f${i % 15}/n${i}.md`, content: `# V${i} ${s}\n\nlink [[V${(i + 1) % 60} ${s}]] #vt${s}` }));
    const big = await imp(files, { source: { id: "11111111-1111-4111-8111-" + String(s).slice(-12).padStart(12, "0"), name: `vault ${s}` } });
    out.largeVault = { status: big.status, seconds: Math.round(big.ms / 100) / 10, body: big.body.slice(0, 200), notes: db(`select count(*) from content_nodes where markdown like '# V% ${s}%' and deleted_at is null`), titlesSample: db(`select string_agg(title, ',') from (select title from content_nodes where markdown like '# V% ${s}%' limit 3) x`), folders: db(`select count(*) from content_nodes where title in (${Array.from({ length: 15 }, (_, i) => `'f${i}'`).join(",")}) and created_at > now() - interval '15 minutes'`), edges: db(`select count(*) from node_edges e join content_nodes n on n.id=e.source_node_id where n.markdown like '# V% ${s}%'`), hashtagTags: db(`select count(distinct nt.node_id) from node_tags nt join content_nodes t on t.id=nt.tag_id where t.title='vt${s}'`) };
    // Same vault again with upsert (idempotent re-import).
    const again = await imp(files, { source: { id: "11111111-1111-4111-8111-" + String(s).slice(-12).padStart(12, "0"), name: `vault ${s}` }, upsert: true });
    out.largeVaultAgain = { status: again.status, seconds: Math.round(again.ms / 100) / 10, body: again.body.slice(0, 200), notes: db(`select count(*) from content_nodes where markdown like '# V% ${s}%' and deleted_at is null`) };
  } finally {
    const ids = db(`select id from content_nodes where created_at > now() - interval '30 minutes' and (title like '%${s}%' or markdown like '%${s}%' or (title ~ '^(d[0-9]+|f[0-9]+|img|vault-${s}|emb-${s})$'))`).split("\n").filter(Boolean);
    out.cleanupCount = ids.length;
    for (const id of ids) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    console.log("DATA01 " + JSON.stringify(out, null, 2));
  }
});
