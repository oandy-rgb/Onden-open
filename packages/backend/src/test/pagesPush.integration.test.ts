// Integration test for the pages_push outbox effect (the static-copy deploy).
// Two layers, against a real Postgres (skips otherwise):
//   A. the outbox state machine for pages_push — per-workspace enqueue/collapse
//      and drain — using an injected performer (no fs / GitHub).
//   B. performPagesPush itself — the static copy (staticSite.ts) of the served
//      site (the latest real publish_snapshots row minus takedowns,
//      servedSite.ts), whose pages come from a stand-in for the frontend
//      (helpers/fakeRenderer.ts), handed to a mocked pushToGitHubPages so we
//      can assert exactly what would deploy.
//
// SAFETY: only runs against a *_test database (skips otherwise). Uses a
// dedicated workspace (own id + unique slug) so it doesn't depend on or pollute
// the 'default' seed.

import { recordSnapshotMedia } from "../services/snapshotMedia.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type CapturedFile = { path: string; content: string | Buffer };

// Capture what performPagesPush would deploy, without touching GitHub.
const h = vi.hoisted(() => ({ captured: null as Array<{ path: string; content: string | Buffer }> | null, domain: "" }));
// The custom domain is read live from siteConfig; setting it for real would append events to the workspace this file deletes.
vi.mock("../services/siteConfig.js", async (original) => {
  const real = await original<typeof import("../services/siteConfig.js")>();
  return { ...real, getSiteConfig: async (ws: string) => ({ ...(await real.getSiteConfig(ws)), custom_domain: h.domain }) };
});
vi.mock("../modules/website/publishing/githubPages.js", () => ({
  pushToGitHubPages: async (files: Array<{ path: string; content: string | Buffer }>) => {
    h.captured = files;
    return "https://example.test/";
  },
  expectedPagesUrl: () => "https://example.test/",
}));

import { pool, q } from "../db.js";
import { enqueuePagesPush, drainOutbox, type OutboxEffectKind } from "../services/outbox.js";
import fc from "fast-check";
import { listSnapshots } from "../modules/website/publishing/snapshot.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { staticSiteUrl, normalizeCustomDomain } from "../modules/website/publishing/cname.js";
import { performPagesPush } from "../modules/website/publishing/pagesPush.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// Dedicated workspace (publish_snapshots.workspace_id has a FK → workspaces).
const WS = "00000000-0000-0000-0000-0000000c0001";

/** A note the site may serve: marked for publishing, in a publishing space.
 *  The push takes down anything else in the snapshot. */
async function publishedNode(markdown: string): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content','Home',$2,$3) RETURNING id::text`, [WS, `home-${randomUUID()}`, markdown])).rows[0]!.id;
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published','true','bool')`, [WS, id]);
  await putInSpace(id, publishing);
  return id;
}
let publishing = "";

describe.skipIf(!isTestDb)("pages_push outbox effect (DB)", () => {
  let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;

  beforeAll(async () => {
    await q(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'PagesPushTest', 'pages-push-test-ws')
       ON CONFLICT (id) DO NOTHING`,
      [WS],
    );
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND node_type <> 'class_tag'`, [WS]);
    publishing = await makeSpace(WS, `pages-push-${Date.now()}`, [], { publish: true, external_ai: false, backup: true });

    renderer = await startFakeRenderer(WS);
  });

  afterAll(async () => {
    await renderer?.close();
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND node_type <> 'class_tag'`, [WS]);
    publishing = await makeSpace(WS, `pages-push-${Date.now()}`, [], { publish: true, external_ai: false, backup: true });
    await q(`DELETE FROM workspaces WHERE id = $1`, [WS]); // cascades publish_snapshots
    await pool.end();
  });

  // ── A. state machine ──────────────────────────────────────────────────────

  it("enqueue creates one pending intent per workspace, collapsing to the latest snapshot", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND node_type <> 'class_tag'`, [WS]);
    publishing = await makeSpace(WS, `pages-push-${Date.now()}`, [], { publish: true, external_ai: false, backup: true });
    await enqueuePagesPush({ workspaceId: WS, snapshotId: "snap-1" });
    await enqueuePagesPush({ workspaceId: WS, snapshotId: "snap-2-latest" });
    const rows = await q<{ payload: { snapshotId: string } }>(
      `SELECT payload FROM outbox WHERE dedup_key = $1 AND status = 'pending'`,
      [`pages_push:${WS}`],
    );
    expect(rows.rows.length).toBe(1); // partial-unique index → one pending per workspace
    expect(rows.rows[0]!.payload.snapshotId).toBe("snap-2-latest"); // superseded to newest
  });

  it("drain runs the pages_push effect and marks it done", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND node_type <> 'class_tag'`, [WS]);
    publishing = await makeSpace(WS, `pages-push-${Date.now()}`, [], { publish: true, external_ai: false, backup: true });
    await enqueuePagesPush({ workspaceId: WS, snapshotId: "snap-done" });
    const seen: OutboxEffectKind[] = [];
    const res = await drainOutbox({ workspaceId: WS, perform: async (kind) => { seen.push(kind); } });
    expect(res.done).toBe(1);
    expect(seen).toEqual(["pages_push"]);
    const left = await q<{ status: string }>(`SELECT status FROM outbox WHERE dedup_key = $1`, [`pages_push:${WS}`]);
    expect(left.rows[0]!.status).toBe("done");
  });

  // ── B. performPagesPush data correctness ──────────────────────────────────

  it("performPagesPush deploys the static copy of the served site — its pages, assets and nothing taken down", async () => {
    const home = await publishedNode("# Hi");
    const ins = await q<{ id: string }>(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        WS, "Test Site", null, 0,
        {
          nodes: [
            { id: home, node_type: "content", title: "Home", slug: "home", markdown: "# Hi" },
            // In the snapshot, since taken down (no such published note now).
            { id: "00000000-0000-0000-0000-0000000c0002", node_type: "content", title: "Gone", slug: "gone", markdown: "x" },
          ],
          edges: [],
          presentation: { template: "clean-docs", site: { brand: "B" } },
          settings_frozen: true,
        },
        "/x/",
      ],
    );
    const snapshotId = ins.rows[0]!.id;

    try {
      h.captured = null;
      await performPagesPush({ snapshotId, workspaceId: WS });

      expect(h.captured).not.toBeNull();
      const files = h.captured!;
      const paths = files.map((f) => f.path);
      for (const p of ["index.html", "404.html", "robots.txt", "site/index.html", "site/home/index.html", "site/feed.xml", "site/sitemap.xml", "_astro/site.css", "_astro/f.woff2", ".nojekyll"]) {
        expect(paths, p).toContain(p);
      }
      expect(paths.some((p) => p.includes("gone"))).toBe(false); // the taken-down note has no page
      expect(paths).not.toContain("site.json"); // the SPA's data file is gone with the SPA

      // Addresses are relative and the copy names itself, not the live site.
      const home1 = String(files.find((f) => f.path === "site/home/index.html")!.content);
      expect(home1).toContain('href="../index.html"');
      expect(home1).toContain('href="../../_astro/site.css"');
      expect(home1).toContain("https://example.test/site/"); // canonical from expectedPagesUrl
      expect(home1).not.toMatch(/(?:href|src)="\/(?:site|_astro)/);
      expect(String(files.find((f) => f.path === "robots.txt")!.content)).toContain("Sitemap: https://example.test/site/sitemap.xml");
    } finally {
      await q(`DELETE FROM publish_snapshots WHERE id = $1`, [snapshotId]);
    }
  });

  // Scan 13 中等 7: with a custom domain the CNAME makes the copy live at that
  // domain, so its canonical links, sitemap and robots must name it, not github.io.
  it("names the custom domain, not github.io, in the static copy and the publish log link", async () => {
    const home = await publishedNode("# Hi");
    const snap = await q<{ id: string }>(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref)
       VALUES ($1,'Test Site',NULL,0,$2,'/x/') RETURNING id`,
      [WS, { nodes: [{ id: home, node_type: "content", title: "Home", slug: "home", markdown: "# Hi" }], edges: [], presentation: { template: "clean-docs", site: { brand: "B" } }, settings_frozen: true }],
    );
    try {
      h.domain = "blog.example.com";
      expect(await staticSiteUrl(WS)).toBe("https://blog.example.com/");
      h.captured = null;
      await performPagesPush({ snapshotId: snap.rows[0]!.id, workspaceId: WS });
      const files = h.captured!;
      expect(String(files.find((f) => f.path === "site/home/index.html")!.content)).toContain("https://blog.example.com/site/");
      expect(String(files.find((f) => f.path === "robots.txt")!.content)).toContain("Sitemap: https://blog.example.com/site/sitemap.xml");
      expect(files.some((f) => typeof f.content === "string" && f.content.includes("example.test"))).toBe(false);
      expect(files.find((f) => f.path === "CNAME")!.content).toBe("blog.example.com\n");

      // The publish log's link and the served site's address follow the setting NOW, not the one at publish time
      // (the snapshot above was stored with "/x/"): set after a publish, and cleared again.
      const address = async () => [(await listSnapshots(WS))[0]!.artifact_ref, (await loadServedSite(WS)).artifact_ref];
      expect(await address()).toEqual(["https://blog.example.com/", "https://blog.example.com/"]);
      h.domain = "";
      expect(await address()).toEqual(["https://example.test/", "https://example.test/"]);
      h.domain = "blog.example.com";

      // Any valid domain wins over the github.io address; an invalid or empty one leaves it.
      const hosts = fc.stringMatching(/^[a-z][a-z0-9]{0,8}(\.[a-z][a-z0-9]{0,8}){1,2}\.(com|org|tw)$/);
      await fc.assert(fc.asyncProperty(fc.oneof(hosts, fc.constantFrom("", "not a domain", "https://")), async (domain) => {
        h.domain = domain;
        const url = await staticSiteUrl(WS);
        const want = normalizeCustomDomain(domain) ? `https://${normalizeCustomDomain(domain)}/` : "https://example.test/";
        expect(url).toBe(want);
        expect((await listSnapshots(WS))[0]!.artifact_ref).toBe(want);
      }), { numRuns: process.env.PROPS_RUNS ? Number(process.env.PROPS_RUNS) : 15 });
    } finally {
      h.domain = "";
      await q(`DELETE FROM publish_snapshots WHERE id = $1`, [snap.rows[0]!.id]);
    }
  });

  it("bundles referenced media blobs and rewrites /api/media refs to relative paths", async () => {
    // A real media blob on disk (1x1 png bytes), referenced from a node body and
    // from the site logo as /api/media/<file>.
    mkdirSync(MEDIA_DIR, { recursive: true });
    const mediaName = "0000000000000000000000000000beef.webp";
    const blobBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xde, 0xad, 0xbe, 0xef]); // not utf8-safe
    writeFileSync(join(MEDIA_DIR, mediaName), blobBytes);
    const missingName = "00000000000000000000000000000404.webp"; // referenced but absent
    const markdown = `# Hi\n\n![fig](/api/media/${mediaName})\n\n![gone](/api/media/${missingName})`;
    const home = await publishedNode(markdown);
    // A file only a private note embeds: /api/media refuses it to anonymous
    // readers, so the static host must not get it either.
    const privateName = "0000000000000000000000000000cafe.webp";
    writeFileSync(join(MEDIA_DIR, privateName), blobBytes);
    await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, created_at)
             VALUES ($1,'manual','content','Private','private',$2, now() - interval '1 day')`,
      [WS, `![p](/api/media/${privateName})`]);

    const payload = {
      nodes: [{
        id: home, node_type: "content", title: "Home", slug: "home",
        markdown: `${markdown}\n\n![p](/api/media/${privateName})`,
      }],
      edges: [],
      presentation: { template: "clean-docs", site: { brand: "B", logo: `/api/media/${mediaName}` } },
      settings_frozen: true,
    };
    const ins = await q<{ id: string }>(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [WS, "Media Site", null, 0, payload, "/x/"],
    );
    const snapshotId = ins.rows[0]!.id;
    await recordSnapshotMedia(snapshotId, payload); // what a publish records beside its snapshot

    try {
      h.captured = null;
      await performPagesPush({ snapshotId, workspaceId: WS });
      const files = h.captured! as CapturedFile[];

      // The present blob is copied into the bundle as raw bytes under media/.
      const blob = files.find((f) => f.path === `media/${mediaName}`);
      expect(blob).toBeDefined();
      expect(Buffer.isBuffer(blob!.content)).toBe(true);
      expect(Buffer.compare(blob!.content as Buffer, blobBytes)).toBe(0);

      // The absent blob is skipped (no bundle entry, deploy still succeeds).
      expect(files.some((f) => f.path === `media/${missingName}`)).toBe(false);
      // The private note's file stays off the static host.
      expect(files.some((f) => f.path === `media/${privateName}`)).toBe(false);

      // The pages no longer point back at the origin's /api/media/*: the figure and
      // the logo are rewritten to the bundled copy, relative to each page.
      const page = String(files.find((f) => f.path === "site/home/index.html")!.content);
      expect(page).not.toContain("/api/media/");
      expect(page).toContain(`../../media/${mediaName}`);
      expect(String(files.find((f) => f.path === "site/index.html")!.content)).toContain(`../media/${mediaName}`); // the logo
      expect(String(files.find((f) => f.path === "404.html")!.content)).toContain(`media/${mediaName}`);
    } finally {
      await q(`DELETE FROM publish_snapshots WHERE id = $1`, [snapshotId]);
      for (const name of [mediaName, privateName]) if (existsSync(join(MEDIA_DIR, name))) rmSync(join(MEDIA_DIR, name));
    }
  });

  it("performPagesPush throws (→ outbox retry) when the snapshot is missing", async () => {
    await expect(
      performPagesPush({ snapshotId: "00000000-0000-0000-0000-0000000c9999", workspaceId: WS }),
    ).rejects.toThrow(/snapshot .* not found/);
  });
});
