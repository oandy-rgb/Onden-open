// Save-path property at nodeUpdate's merge decision (services/nodeUpdate.ts,
// "Concurrent-edit merge"): a save that did not change the body must leave a
// newer server body alone.
//
// The editor re-sends the whole note on every autosave, so a title-only
// rename arrives as { title, markdown: <the body it loaded> } with that same
// body as `baseMarkdown`. The decision skips the merge when incoming ===
// base, then writes `incoming` over the server's newer body, which another
// writer saved in between. The fix is PR fix/a1-save-path; the `it.fails`
// below flips to a plain pass (and vitest then reports it) once that merges.
// The nodeUpdate decision is inline in updateNode, not a function that can be
// called without a database, so this runs against the test database.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { checkAsync } from "./helpers/propsConfig.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
/** Each run is several database writes; the property keeps its own cap. */
const MAX_DB_RUNS = 30;

// Non-blank, distinct-per-position lines: a body the server stores as sent.
const lines = fc.array(fc.stringMatching(/^[a-zA-Z一-龥]{1,10}$/), { minLength: 1, maxLength: 8 })
  .map((ls) => ls.map((l, i) => `${l}${i}`));

describe.skipIf(!isTestDb)("a save that did not change the body vs a newer server body", () => {
  let ws = "";
  let defaultSpace = "";
  const stamp = Date.now();
  let serial = 0;
  const owner: ActorCtx = { id: "", name: "Owner", role: "admin", type: "human" };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(owner, await persistActor(ws, owner));
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [ws, `PROP %${stamp}%`]);
    await pool.end();
  });

  const app = () => {
    const a = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    a.onError(apiOnError);
    a.use("*", async (c, next) => { c.set("actor", owner); await next(); });
    a.route("/api/nodes", nodeRouter);
    return a;
  };
  const createNote = async (markdown: string) => (await (await app().request("/api/nodes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `PROP ${stamp} ${serial++}`, markdown, space_id: defaultSpace }),
  })).json() as { id: string }).id;
  const bodyOf = async (id: string) =>
    (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

  /** Note holds `loaded`; another writer then saves `newer` over it. */
  const noteWithNewerServerBody = async (loaded: string, newer: string) => {
    const id = await createNote(loaded);
    await updateNode(ws, id, { markdown: newer }, { actor: owner, baseMarkdown: loaded });
    expect(await bodyOf(id)).toBe(newer);
    return id;
  };

  it("control: an edited save with a stale base still merges onto the newer server body", async () => {
    await checkAsync(fc.asyncProperty(lines, async (ls) => {
      fc.pre(ls.length >= 3);
      const loaded = `${ls.join("\n")}\n`;
      const newer = `${ls.slice(0, -1).join("\n")}\nserver edit\n`; // last line replaced on the server
      const id = await noteWithNewerServerBody(loaded, newer);
      // This writer edits the first line, based on the body it loaded.
      await updateNode(ws, id, { markdown: loaded.replace(ls[0]!, "writer edit") }, { actor: owner, baseMarkdown: loaded });
      expect(await bodyOf(id)).toBe(`writer edit\n${ls.slice(1, -1).join("\n")}\nserver edit\n`);
    }), MAX_DB_RUNS);
  }, 30_000);

  // nodeUpdate.ts once skipped the merge when incoming === base and wrote the stale body.
  it("a title-only save (body === base) never replaces a newer server body", async () => {
    await checkAsync(fc.asyncProperty(lines, lines, async (loadedLines, newerLines) => {
      const loaded = `${loadedLines.join("\n")}\n`;
      const newer = `${newerLines.join("\n")}\n`;
      fc.pre(loaded !== newer);
      const id = await noteWithNewerServerBody(loaded, newer);
      await updateNode(ws, id, { title: `PROP ${stamp} ${serial++} renamed`, markdown: loaded }, { actor: owner, baseMarkdown: loaded });
      expect(await bodyOf(id), "the rename wrote the body it loaded over the newer one").toBe(newer);
    }), MAX_DB_RUNS);
  }, 30_000);
});
