// How long the published site takes, with the real Astro server in front of
// the real GET /api/site: one SSR page, one static copy build, one /api/site.
//
//   npm run build -w packages/frontend      (the SSR server this measures)
//   BENCH_DATABASE_URL=postgres://…/onden_sitecache_bench npx tsx scripts/bench/siteCache.ts [--notes=200] [--runs=9]
//
// The database name must end in `_bench`; it is dropped and rebuilt. The API
// runs in this process on API_PORT, the SSR server (packages/frontend/dist) as
// a child on SSR_PORT with SSR_API_URL pointing here. Prints one JSON object.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postVia, publishWithPreview } from "../../src/test/helpers/publishWithPreview.js";
import { assertBenchDatabase, benchDatabaseUrl, recreateBenchDatabase } from "./common.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const NOTES = Number(arg("notes") ?? 200);
const RUNS = Number(arg("runs") ?? 9);
const API_PORT = 8791;
const SSR_PORT = 4391;

const url = benchDatabaseUrl();
assertBenchDatabase(url);
process.env.DATABASE_URL = url; // db.ts reads it on first import

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function timed<T>(run: () => Promise<T>): Promise<number> {
  const t = performance.now();
  await run();
  return performance.now() - t;
}
const round = (n: number) => Math.round(n * 10) / 10;

async function main() {
  await recreateBenchDatabase(url);
  const { q } = await import("../../src/db.js");
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const { default: nodesRouter } = await import("../../src/routes/nodes.js");
  const { default: publishRouter } = await import("../../src/modules/website/routes.js");
  const { apiOnError } = await import("../../src/httpError.js");
  const { persistActor } = await import("../../src/test/helpers/persistActor.js");
  const { makeSpace, putInSpace } = await import("../../src/test/helpers/spaceFixtures.js");
  const { registerShippedModules } = await import("../../src/test/helpers/registerShippedModules.js");
  const { buildStaticSite } = await import("../../src/modules/website/publishing/staticSite.js");

  const workspaceId = (await q<{ id: string }>(`SELECT id FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
  const owner = await persistActor(workspaceId, { id: "bench-owner", name: "Owner", role: "admin", type: "human" });
  const space = await makeSpace(workspaceId, "bench", [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  registerShippedModules();

  // Owner requests for seeding and publishing; the public site is anonymous.
  const api = new Hono<{ Variables: { actor: typeof owner | null } }>();
  api.onError(apiOnError);
  api.use("*", async (c, next) => { c.set("actor", c.req.path === "/api/site" ? null : owner); await next(); });
  api.route("/api/nodes", nodesRouter);
  api.route("/api", publishRouter);
  let siteHits = 0;
  let siteBytes = 0;
  const server = serve({
    port: API_PORT,
    fetch: async (req) => {
      const res = await api.fetch(req);
      if (new URL(req.url).pathname === "/api/site") {
        siteHits++;
        if (res.status === 200) siteBytes += (await res.clone().arrayBuffer()).byteLength;
      }
      return res;
    },
  });

  const sentence = "資料結構的選擇會影響後面的實作，單元測試與整合測試各有用處。 Keep the markdown source readable without any tooling. ";
  const ids: Array<{ id: string; slug: string }> = [];
  for (let i = 0; i < NOTES; i++) {
    const slug = `note-${i}`;
    const link = i > 0 ? `\n\n見 [[note-${i - 1}]]` : "";
    const body = `# 筆記 ${i}\n\n${(sentence + "\n\n").repeat(12)}${link}`;
    const id = (await q<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,$4) RETURNING id::text`, [workspaceId, `筆記 ${i}`, slug, body])).rows[0]!.id;
    await putInSpace(id, space);
    await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, '_published', 'true', 'bool')`, [workspaceId, id]);
    ids.push({ id, slug });
  }
  // The route publishes only a candidate the caller previewed (by its hash).
  const published = await publishWithPreview(postVia(api), {});
  if (published.status !== 201) throw new Error(`publish answered ${published.status}: ${await published.text()}`);

  const ssr = spawn("node", [resolve(here, "../../../frontend/dist/server/entry.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(SSR_PORT), SSR_API_URL: `http://localhost:${API_PORT}` },
    stdio: "ignore",
  });
  try {
    const ssrUrl = `http://127.0.0.1:${SSR_PORT}`;
    for (let i = 0; ; i++) {
      if (await fetch(`${ssrUrl}/site/`).then((r) => r.ok, () => false)) break;
      if (i > 100) throw new Error("the SSR server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }

    const result: Record<string, unknown> = { notes: NOTES, runs: RUNS };
    // The backend alone: GET /api/site with no validator (the full site), then with the current ETag.
    const apiUrl = `http://localhost:${API_PORT}/api/site`;
    const first = await fetch(apiUrl);
    const etag = first.headers.get("ETag");
    result.api_site_bytes = (await first.arrayBuffer()).byteLength;
    result.api_site_full_ms = round(median(await (async () => {
      const t: number[] = [];
      for (let i = 0; i < RUNS; i++) t.push(await timed(async () => { await (await fetch(apiUrl)).arrayBuffer(); }));
      return t;
    })()));
    if (etag) {
      const t: number[] = [];
      for (let i = 0; i < RUNS; i++) t.push(await timed(async () => { await (await fetch(apiUrl, { headers: { "If-None-Match": etag } })).arrayBuffer(); }));
      result.api_site_if_none_match_ms = round(median(t));
    }

    // One SSR page (a note's page, as a reader opens it), after one warm-up.
    const pageUrl = `${ssrUrl}/site/${ids[Math.floor(NOTES / 2)]!.slug}/`;
    await (await fetch(pageUrl)).text();
    siteHits = 0; siteBytes = 0;
    const pages: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      pages.push(await timed(async () => { const r = await fetch(pageUrl); if (!r.ok) throw new Error(`page answered ${r.status}`); await r.text(); }));
    }
    result.ssr_page_ms = round(median(pages));
    result.ssr_page_api_hits = siteHits;
    result.ssr_page_api_mb = round(siteBytes / 1e6);

    // The static copy: a crawl of every page, three times.
    const builds: number[] = [];
    siteHits = 0; siteBytes = 0;
    for (let i = 0; i < 3; i++) builds.push(await timed(() => buildStaticSite({ workspaceId, ssrUrl })));
    result.static_build_ms = round(median(builds));
    result.static_build_api_hits_per_build = siteHits / 3;
    result.static_build_api_mb_per_build = round(siteBytes / 3 / 1e6);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    ssr.kill();
    server.close();
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
