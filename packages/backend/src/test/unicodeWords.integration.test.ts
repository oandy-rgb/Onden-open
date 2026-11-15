// D58: names in note text keep their combining marks and are compared in NFC.
// Before it every text grammar read `[\p{L}\p{N}]`, so a Devanagari title's
// vowel signs fell out of its slug ("कल", "काल" and "कील" were one slug and a
// [[link]] got edges to all three), `#हिंदी` searched as text and `कीमत:: 5`
// was no attribute; and a title from a macOS zip (NFD) never matched the same
// [[link]] typed elsewhere (NFC).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { awaitNodeDispatcher } from "../services/dispatcherQueue.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };
const send = (method: string, path: string, body?: unknown) => Promise.resolve(app.request(path, {
  method, headers: { ...NATIVE, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

// A run stamp in digits only would be a separate word; letters keep it in the name.
const STAMP = `r${Date.now().toString(36)}`;
const nfd = (s: string) => s.normalize("NFD");

async function createNote(title: string, markdown = ""): Promise<{ id: string; slug: string; title: string }> {
  const res = await send("POST", "/api/nodes", { title, markdown });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  const body = (await res.json()) as { id?: string; node?: { id: string } };
  const id = body.node?.id ?? body.id!;
  return (await q<{ id: string; slug: string; title: string }>(`SELECT id, slug, title FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
}

async function linkTargets(sourceId: string): Promise<string[]> {
  return (await q<{ target_node_id: string }>(
    `SELECT target_node_id FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink' AND status = 'active'`, [sourceId],
  )).rows.map((r) => r.target_node_id).sort();
}

describe.skipIf(!isTestDb)("Unicode words and NFC names (D58)", () => {
  let WS = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("(1)(2) a Devanagari title keeps its vowel signs, and a [[link]] reaches only its note", async () => {
    const [kal, kaal, keel] = [
      await createNote(`कल ${STAMP}`), await createNote(`काल ${STAMP}`), await createNote(`कील ${STAMP}`),
    ];
    expect(kaal.slug).toBe(`काल-${STAMP.toLowerCase()}`);
    expect(new Set([kal.slug, kaal.slug, keel.slug]).size).toBe(3);
    const source = await createNote(`source ${STAMP}`, `see [[काल ${STAMP}]] and [[${kaal.slug}]]`);
    expect(await linkTargets(source.id)).toEqual([kaal.id]);
  });

  it("(3) #हिंदी is a tag filter in search, not text", async () => {
    // A note whose text has the word, and no such tag: as text the query
    // found the note; as a tag filter for a tag that does not exist, nothing.
    await createNote(`text ${STAMP}`, `#हिंदी${STAMP} in prose`);
    const res = await send("GET", `/api/nodes/search?q=${encodeURIComponent(`#हिंदी${STAMP}`)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    const { parseSearchQuery } = await import("@onden/markdown");
    expect(parseSearchQuery(`#हिंदी ${nfd("#Café")}`)).toEqual({ text: "", tags: ["हिंदी", "café"], attrs: [] });
  });

  it("(4) a `कीमत:: 5` line is an attribute of the note", async () => {
    const note = await createNote(`attr ${STAMP}`, "कीमत:: 5\n");
    const rows = (await q<{ key: string; value: string }>(
      `SELECT key, value FROM node_attributes WHERE node_id = $1 AND key = $2`, [note.id, "कीमत"],
    )).rows;
    expect(rows).toEqual([{ key: "कीमत", value: "5" }]);
    // An NFD key read from text lands on the same NFC key.
    expect((await send("PATCH", `/api/nodes/${note.id}`, { markdown: `${nfd("Café")}:: 1\n` })).status).toBe(200);
    // An edit re-derives inline attributes after commit (bodySideEffects):
    // wait for it, or a dispatcher still busy with an earlier test's save
    // makes this read race the derivation.
    await awaitNodeDispatcher(note.id);
    const keys = (await q<{ key: string }>(`SELECT key FROM node_attributes WHERE node_id = $1 AND key LIKE 'Caf%'`, [note.id])).rows;
    expect(keys.map((k) => k.key)).toEqual(["Café"]);
  });

  it("(5) an NFD title from a zip import is stored NFC and an NFC [[link]] resolves to it", async () => {
    const title = `Café 한글 ${STAMP}`;
    const res = await send("POST", "/api/import/obsidian", {
      source: { id: "legacy", name: "Older imports" },
      files: [{ path: nfd(`${STAMP}/${title}.md`), content: "imported body" }],
      upsert: false,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const imported = (await q<{ id: string; title: string; slug: string }>(
      `SELECT id, title, slug FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [WS, title],
    )).rows;
    expect(imported).toHaveLength(1);
    expect(imported[0]!.title).toBe(title.normalize("NFC"));
    const source = await createNote(`linker ${STAMP}`, `[[${title}]]`);
    expect(await linkTargets(source.id)).toEqual([imported[0]!.id]);
  });

  it("a title stored NFD before D58 is still found by an NFC link (no re-slug)", async () => {
    const legacy = await createNote(`legacy ${STAMP}`);
    const oldTitle = nfd(`Résumé ${STAMP}`);
    // As the old rule stored it: NFD title, the accent-less slug.
    await seedQ(`UPDATE content_nodes SET title = $2, slug = $3 WHERE id = $1`, [legacy.id, oldTitle, `resume-${STAMP.toLowerCase()}`]);
    const source = await createNote(`legacy linker ${STAMP}`, `[[Résumé ${STAMP}]]`);
    expect(await linkTargets(source.id)).toEqual([legacy.id]);
    expect((await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [legacy.id])).rows[0]!.slug)
      .toBe(`resume-${STAMP.toLowerCase()}`);
    // An autosave re-sends the same title (composed): the note keeps the slug
    // the old rule gave it, as a Devanagari note does its mark-less one.
    expect((await send("PATCH", `/api/nodes/${legacy.id}`, { title: `Résumé ${STAMP}`, markdown: "edited" })).status).toBeLessThan(300);
    const kept = (await q<{ slug: string; title: string }>(`SELECT slug, title FROM content_nodes WHERE id = $1`, [legacy.id])).rows[0]!;
    expect(kept).toEqual({ slug: `resume-${STAMP.toLowerCase()}`, title: `Résumé ${STAMP}`.normalize("NFC") });
    const hindi = await createNote(`काल old ${STAMP}`);
    await seedQ(`UPDATE content_nodes SET slug = $2 WHERE id = $1`, [hindi.id, `कल-old-${STAMP.toLowerCase()}`]);
    expect((await send("PATCH", `/api/nodes/${hindi.id}`, { title: `काल old ${STAMP}`, markdown: "x" })).status).toBeLessThan(300);
    expect((await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [hindi.id])).rows[0]!.slug)
      .toBe(`कल-old-${STAMP.toLowerCase()}`);
  });

  it("re-saving a tag whose name was stored decomposed is no rename", async () => {
    const res = await send("POST", "/api/tags/resolve-path", { path: `Été${STAMP}` });
    const { leaf_id } = (await res.json()) as { leaf_id: string };
    await seedQ(`UPDATE content_nodes SET title = $2, slug = 'tag-legacy-${STAMP.toLowerCase()}' WHERE id = $1`, [leaf_id, nfd(`Été${STAMP}`)]);
    expect((await send("PATCH", `/api/nodes/${leaf_id}`, { title: `Été${STAMP}`, markdown: "about" })).status).toBeLessThan(300);
    expect((await send("PATCH", `/api/tags/${leaf_id}`, { name: `Été${STAMP}` })).status).toBeLessThan(300);
    const row = (await q<{ title: string; slug: string }>(`SELECT title, slug FROM content_nodes WHERE id = $1`, [leaf_id])).rows[0]!;
    expect(row).toEqual({ title: nfd(`Été${STAMP}`), slug: `tag-legacy-${STAMP.toLowerCase()}` });
    const renames = await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'TAG_UPDATED'`, [leaf_id]);
    expect(renames.rowCount).toBe(0);
  });

  it("a note created after the link, with an NFD title, wires the earlier NFC link", async () => {
    const source = await createNote(`early ${STAMP}`, `[[Naïve ${STAMP}]]`);
    const target = await createNote(nfd(`Naïve ${STAMP}`));
    expect(target.title).toBe(`Naïve ${STAMP}`.normalize("NFC"));
    expect(await linkTargets(source.id)).toEqual([target.id]);
  });

  it("a body that spells the link NFD is wired when the NFC-titled target is created (relinkTarget)", async () => {
    // Bodies are not rewritten, so a note imported from a macOS zip keeps an
    // NFD [[link]]; the incoming-edge prefilter looks for both spellings.
    const source = await createNote(`nfd body ${STAMP}`, nfd(`see [[Crème ${STAMP}]]`));
    const target = await createNote(`Crème ${STAMP}`);
    expect(await linkTargets(source.id)).toEqual([target.id]);
    // And a rename onto the NFD-spelled name wires it too.
    const renamed = await createNote(`Before ${STAMP}`);
    const later = await createNote(`nfd body 2 ${STAMP}`, nfd(`[[Brûlée ${STAMP}]]`));
    expect(await linkTargets(later.id)).toEqual([]);
    const res = await send("PATCH", `/api/nodes/${renamed.id}`, { title: `Brûlée ${STAMP}` });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(await linkTargets(later.id)).toEqual([renamed.id]);
  });

  it("a tag named NFD is stored NFC and found by its NFC name", async () => {
    const res = await send("POST", "/api/tags/resolve-path", { path: nfd(`Thé${STAMP}`) });
    expect(res.status).toBe(200);
    const { leaf_id } = (await res.json()) as { leaf_id: string };
    const again = await send("POST", "/api/tags/resolve-path", { path: `Thé${STAMP}` });
    expect(((await again.json()) as { leaf_id: string }).leaf_id).toBe(leaf_id);
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [leaf_id])).rows[0]!.title)
      .toBe(`Thé${STAMP}`.normalize("NFC"));
  });
});
