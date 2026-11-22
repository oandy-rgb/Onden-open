// The write paths the first version tests did not walk (review of PR #1938 round 1, point 13): copying a note, a template's children, a
// Notion database's rows, and a backup moved in with its history (importedHistory after migration 220). Each: the path mints the version
// it should (its kind, its content stored, the key the rule gives), and leaves sync_clock.version_misses at 0 (spine/noteVersions.ts
// countVersionMisses, what the server logs at boot).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { q } from "../db.js";
import { workspaceSwitch } from "./helpers/workspaceSwitch.js";

vi.mock("../db.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
vi.mock("../services/workspaceId.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../services/workspaceId.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
import { countVersionMisses } from "../spine/noteVersions.js";
import { importNotionDatabases } from "../modules/importers/notion/database.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { fullBackup } from "./helpers/roundTripApi.js";
import { moveInto, place, type Place } from "./helpers/backupMoveWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";

registerShippedModules();

type Version = { version_key: string; kind: string; title: string | null; content: string | null };
/** A note's body versions, oldest first, with the text each names (null: no blob holds it). */
const versionsOf = async (noteId: string): Promise<Version[]> => (await q<Version>(
  `SELECT v.version_key, v.kind, v.title, b.content FROM note_versions v LEFT JOIN blobs b ON b.hash = v.content_hash
    WHERE v.note_id = $1 AND v.unit = 'body' ORDER BY v.clock_wall NULLS FIRST, v.clock_counter, v.at, v.ordinal`, [noteId])).rows;
const idOf = async (ws: string, title: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title])).rows[0]!.id;

describe.skipIf(!isTestDatabase())("the other write paths mint their versions and miss none", () => {
  let here: Place;
  beforeAll(async () => { here = await place("versions-paths"); });
  afterAll(async () => { await awaitAllDispatchers(); workspaceSwitch.ws = ""; });

  it("a copy of a note is one version of its own, created, naming the copied text", async () => {
    workspaceSwitch.ws = here.ws;
    const id = (await here.call("POST", "/api/nodes", { title: "Original", markdown: "text to copy", space_id: here.personal })).id as string;
    const copy = (await here.call("POST", `/api/nodes/${id}/duplicate`, {})).id as string;
    const versions = await versionsOf(copy);
    expect(versions.map((v) => [v.kind, v.content])).toEqual([["created", "text to copy"]]);
    expect(versions[0]!.version_key).toMatch(/^s:/);
    expect(versions[0]!.version_key).not.toBe((await versionsOf(id))[0]!.version_key);
    expect(await countVersionMisses(here.ws)).toBe(0);
  });

  it("a template's children are each one version, created, naming their text", async () => {
    workspaceSwitch.ws = here.ws;
    const tag = (await here.call("POST", "/api/tags/import", {
      name: `versions-tpl-${randomUUID().slice(0, 6)}`, fields: [],
      template_children: [{ title: "Summary", body: "the summary's text" }, { title: "Notes", body: "" }],
    })).id as string;
    const parent = (await here.call("POST", "/api/nodes", { title: "Book", markdown: "a book", space_id: here.personal })).id as string;
    await here.call("PUT", `/api/nodes/${parent}/tags/${tag}`, {});
    const children = (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE parent_id = $1 ORDER BY title`, [parent])).rows;
    expect(children.map((c) => c.title)).toEqual(["Notes", "Summary"]);
    expect((await versionsOf(children[0]!.id)).map((v) => [v.kind, v.title, v.content])).toEqual([["created", "Notes", ""]]);
    expect((await versionsOf(children[1]!.id)).map((v) => [v.kind, v.title, v.content])).toEqual([["created", "Summary", "the summary's text"]]);
    expect(await countVersionMisses(here.ws)).toBe(0);
  });

  it("a Notion database's row is a version when made and another when its page body is saved into it", async () => {
    workspaceSwitch.ws = here.ws;
    const db = `Versions DB ${randomUUID().slice(0, 6)}`;
    const result = await importNotionDatabases(here.ws, [{ path: `${db}.csv`, content: `Name,Status\nRow one,Open\nRow two,Done\n` }],
      [{ path: `${db}/Row one.md`, content: `# Row one\n\nthe row's own page\n` }], here.owner);
    await awaitAllDispatchers();
    expect(result).toMatchObject({ rows: 2, bodiesAttached: 1 });
    // the row is made empty, then its page body is saved into it (two events, two versions)
    const one = await versionsOf(await idOf(here.ws, "Row one"));
    expect(one.map((v) => [v.kind, v.title])).toEqual([["created", "Row one"], ["updated", "Row one"]]);
    expect(one[1]!.content).toContain("the row's own page");
    expect((await versionsOf(await idOf(here.ws, "Row two"))).map((v) => v.kind)).toEqual(["created"]);
    expect(await countVersionMisses(here.ws)).toBe(0);
  });

  it("a backup moved in with its history: each carried save is the `g:` version migration 220's rule names; the move's own save mints its own", async () => {
    const source = await place("versions-backup-source");
    const id = (await source.call("POST", "/api/nodes", { title: "Carried", markdown: "first", space_id: source.personal })).id as string;
    await source.call("PATCH", `/api/nodes/${id}`, { markdown: "second" });
    await source.call("PATCH", `/api/nodes/${id}`, { title: "Carried, renamed" });
    const zip = await fullBackup(source.ws, source.owner, "history=1");
    const target = await place("versions-backup-target");
    const job = await moveInto(target, zip);
    expect(job.status, JSON.stringify(job.error)).toBe("done");
    expect(job.result!.moved!.history).toMatchObject({ failed: [] });
    const there = await idOf(target.ws, "Carried, renamed");

    // every carried save maps to the key the SQL rule (note_version_legacy_key, what the backfill uses) gives for that event here
    const carried = (await q<{ key: string; expected: string }>(
      `SELECT ve.version_key AS key,
              note_version_legacy_key(e.target_id::uuid, 'body', CASE e.event_type WHEN 'NODE_CREATED' THEN 'created' WHEN 'NODE_RESTORED' THEN 'restored' ELSE 'updated' END,
                                      e.body_hash, e.payload->>'title', note_version_at(e.created_at)) AS expected
         FROM domain_events e JOIN note_version_events ve ON ve.event_id = e.id
        WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.tx_meta ? 'history_import' ORDER BY e.created_at, e.id`, [target.ws, there])).rows;
    expect(carried).toHaveLength(3);
    for (const c of carried) expect(c.key).toBe(c.expected);
    const versions = await versionsOf(there);
    expect(versions.filter((v) => v.version_key.startsWith("g:")).map((v) => [v.kind, v.title, v.content]))
      .toEqual([["created", "Carried", "first"], ["updated", "Carried", "second"], ["updated", "Carried, renamed", "second"]]);
    expect(versions.every((v) => v.content !== null)).toBe(true);
    // the move made the note here, as a write of this node: its version is an `s:` one
    expect(versions.filter((v) => v.version_key.startsWith("s:")).map((v) => v.kind)).toEqual(["created"]);
    expect(await countVersionMisses(target.ws)).toBe(0);
    expect(await countVersionMisses(source.ws)).toBe(0);
  }, 120_000);
});
