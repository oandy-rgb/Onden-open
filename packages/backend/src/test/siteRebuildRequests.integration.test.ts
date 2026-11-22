// When the site is re-pushed (modules/website/index.ts, effects.ts): an ordinary edit of a note in a space that
// publishes never asks for it (the site is the latest snapshot, so a new body shows at the next Publish); hiding or
// trashing a note the site shows does, once per workspace however many changes come (one pending row, outbox.ts
// dedup_key); a note its own 「不發布」 or a feed's saved article keeps off does not.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import workspaceRouter from "../routes/workspace.js";
import fc from "fast-check";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
registerShippedModules();

describe.skipIf(!isTestDatabase())("what asks the site for a re-push", () => {
  let owner: ActorCtx;
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  app.route("/api/nodes", nodesRouter);
  app.route("/api/workspace", workspaceRouter);
  const send = (url: string, method: string, body: unknown = {}) =>
    app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const pending = async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [WS])).rows[0]!.n;
  const reset = () => q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
  let site = "";

  const note = async (title: string, opts: { source?: string; flag?: string } = {}) => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,$2,'content',$3,$4,'words') RETURNING id::text`,
      [WS, opts.source ?? "manual", title, randomUUID()])).rows[0]!.id;
    await putInSpace(id, site);
    if (opts.flag) await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published',$3,'bool')`, [WS, id, opts.flag]);
    return id;
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Rebuild requests', $1) RETURNING id::text`, [`rebuild-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "owner-rebuild", name: "Owner", role: "admin", type: "human" });
    await turnModuleOn(WS, "website"); // its hooks act only where the owner has it on
    site = await makeSpace(WS, `Site ${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  });

  it("an edit of a note's title and text asks for nothing", async () => {
    const id = await note("Plain");
    await reset();
    expect((await send(`/api/nodes/${id}`, "PATCH", { markdown: "changed words" })).status).toBe(200);
    expect((await send(`/api/nodes/${id}`, "PATCH", { title: "Plain renamed" })).status).toBe(200);
    expect(await pending()).toBe("0");
  });

  // Scan 13 中等 3 (owner 2026-11-20, 「按建議」): emptying a note's text takes it off the live site (publishedSet's
  // blank rule), so the static copy must be pushed again — the same as any other change to what the site shows.
  describe("emptying a note the site shows", () => {
    /** A latest snapshot that carries `ids` (the note the site shows). */
    const snapshotOf = async (ids: string[]) => {
      await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
      await q(`INSERT INTO publish_snapshots (workspace_id, title, event_cursor, payload, artifact_ref) VALUES ($1,'t',0,$2,'/x/')`,
        [WS, { nodes: ids.map((id) => ({ id, node_type: "content", title: "n", slug: id, markdown: "words" })), edges: [] }]);
    };
    const edit = async (id: string, markdown: string) => expect((await send(`/api/nodes/${id}`, "PATCH", { markdown })).status).toBe(200);

    it("asks for a re-push when the text of a note in the snapshot is emptied", async () => {
      const id = await note("To be emptied");
      await snapshotOf([id]);
      await reset();
      await edit(id, "");
      expect(await pending()).toBe("1");
    });

    it("asks for nothing for a note the snapshot does not carry, an edit that leaves text, or a second emptying", async () => {
      const [inSnapshot, other] = [await note("In"), await note("Not in the snapshot")];
      await snapshotOf([inSnapshot]);
      await reset();
      await edit(other, ""); // the site never had it
      await edit(inSnapshot, "still has words");
      expect(await pending()).toBe("0");
      await edit(inSnapshot, " \n ");
      expect(await pending()).toBe("1");
      await reset();
      await edit(inSnapshot, "");
      await edit(inSnapshot, "\n");
      expect(await pending(), "already recorded as taken down").toBe("0");
    });

    it("for any run of edits, a push is asked for exactly when an edit empties a note the site still carries", async () => {
      const texts = fc.constantFrom("words", "more words", "", " \n", "\t");
      await fc.assert(fc.asyncProperty(fc.array(texts, { minLength: 1, maxLength: 6 }), async (steps) => {
        const id = await note("Edited");
        await snapshotOf([id]);
        let current = "words";
        let takenDown = false;
        for (const next of steps) {
          await reset();
          await edit(id, next);
          const emptied = !/\S/.test(next) && !takenDown;
          expect(await pending(), `${JSON.stringify(current)} → ${JSON.stringify(next)}`).toBe(emptied && next !== current ? "1" : "0");
          if (emptied && next !== current) takenDown = true;
          current = next;
        }
      }), { numRuns: process.env.PROPS_RUNS ? Number(process.env.PROPS_RUNS) : 10 });
    });
  });

  // Scan 13 中等 7 (round 2): the publish log's link follows the custom domain at once, so the static copy
  // (CNAME, canonical links) must be pushed again when the domain is set or cleared — and only then.
  describe("custom domain", () => {
    // A published site to push: the rebuild only enqueues once a snapshot exists.
    const publishOnce = async () => {
      await q(`INSERT INTO publish_snapshots (workspace_id, title, event_cursor, payload, artifact_ref) VALUES ($1,'t',0,'{"nodes":[],"edges":[]}'::jsonb,'/x/')`, [WS]);
    };
    const setDomain = async (value: string) =>
      expect((await send("/api/workspace/config", "PATCH", { config: { custom_domain: value } })).status).toBe(200);

    it("setting, changing and clearing the domain each ask once; the same value again, or another setting, asks for nothing", async () => {
      await publishOnce();
      await reset();
      await setDomain("blog.example.com");
      expect(await pending()).toBe("1");
      await reset();
      await setDomain("blog.example.com"); // unchanged
      expect(await pending()).toBe("0");
      expect((await send("/api/workspace/config", "PATCH", { config: { brand: `Brand ${randomUUID()}` } })).status).toBe(200);
      expect(await pending()).toBe("0");
      await setDomain("other.example.com");
      expect(await pending()).toBe("1");
      await reset();
      await setDomain("");
      expect(await pending()).toBe("1");
    });

    it("for any sequence of settings, a push is asked for exactly when the domain changed", async () => {
      await publishOnce();
      const domains = fc.constantFrom("", "a.example.com", "b.example.com", "c.example.org");
      await fc.assert(fc.asyncProperty(fc.array(domains, { minLength: 1, maxLength: 5 }), async (steps) => {
        await setDomain("");
        let current = "";
        for (const next of steps) {
          await reset();
          await setDomain(next);
          expect(await pending(), `${current || "(none)"} → ${next || "(none)"}`).toBe(next === current ? "0" : "1");
          current = next;
        }
      }), { numRuns: process.env.PROPS_RUNS ? Number(process.env.PROPS_RUNS) : 10 });
    });
  });

  it("trashing notes the site shows asks once, however many", async () => {
    const [a, b] = [await note("A"), await note("B")];
    await reset();
    expect((await send(`/api/nodes/${a}`, "DELETE")).status).toBe(200);
    expect((await send(`/api/nodes/${b}`, "DELETE")).status).toBe(200);
    expect(await pending()).toBe("1");
  });

  it("trashing a note kept off by its own 「不發布」 or by its source asks for nothing; one marked 「發布」 does", async () => {
    const keptOff = await note("Kept off", { flag: "false" });
    const article = await note("Saved article", { source: "rss" });
    const articleOn = await note("Article on", { source: "rss", flag: "true" });
    await reset();
    expect((await send(`/api/nodes/${keptOff}`, "DELETE")).status).toBe(200);
    expect((await send(`/api/nodes/${article}`, "DELETE")).status).toBe(200);
    expect(await pending()).toBe("0");
    expect((await send(`/api/nodes/${articleOn}`, "DELETE")).status).toBe(200);
    expect(await pending()).toBe("1");
  });
});
