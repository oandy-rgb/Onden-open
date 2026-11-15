// Round trip 4: the standalone tasks (no host note) in a Markdown export →
// import into an empty workspace.
//
// The export writes them as one list file, 任務/任務.md (Tasks/Tasks.md with
// ?lang=en), plus a note file for each task with body text
// (services/exportTasks.ts, services/taskListFile.ts). Importing that zip must
// give the tasks back as tasks — every field, the body — and not a note called
// "任務" full of checkboxes.
//
// fast-check generates the world (helpers/roundTripArb.ts, standaloneTasks);
// both workspaces are read with snapshotWorkspace. Replay a failing world with
// ROUNDTRIP_SEED=<seed>.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns, worldSpec, type WorldSpec } from "../helpers/roundTripArb.js";
import { buildWorld, freshWorkspace, snapshotWorkspace, type TaskSnapshot } from "../helpers/roundTripWorld.js";
import { exportMarkdown, importFiles, zipFiles } from "../helpers/roundTripApi.js";
import { tagPageTitles } from "../helpers/roundTripCompare.js";
import { isTaskList, parseTaskList } from "../../services/taskListFile.js";

vi.mock("../../db.js", async (original) => {
  const { workspaceSwitch } = await import("../helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();

/** The fields of a standalone task, "何時做" under its one current name. */
const fieldsOf = (t: TaskSnapshot) => Object.fromEntries(Object.entries(t.attributes)
  // When it was completed is the export's ✅ day and the import's stamp, not a field the list carries.
  .filter(([key]) => key.startsWith("_task_") && key !== "_task_done_at")
  .map(([key, value]) => [key === "_task_due" ? "_task_when" : key, value]));
const standalone = (tasks: TaskSnapshot[]) => tasks.filter((t) => t.host === null).map((t) => ({ title: t.title, body: t.body, fields: fieldsOf(t) }));

async function trip(spec: WorldSpec, options: { lang?: "en" } = {}) {
  const a = await freshWorkspace("rt-tasks-a");
  await buildWorld(spec, a);
  const before = await snapshotWorkspace(a.ws);
  const zip = await exportMarkdown(a.ws, a.actor, options);
  const b = await freshWorkspace("rt-tasks-b");
  const report = await importFiles(b.ws, b.actor, zipFiles(zip));
  const after = await snapshotWorkspace(b.ws);
  return { a, b, before, zip, report, after };
}

const listPaths = (zip: Map<string, Buffer>) => [...zip].filter(([, data]) => isTaskList(data.toString("utf8"))).map(([name]) => name);

describe.skipIf(!enabled)("standalone tasks: Markdown export → import into an empty workspace", () => {
  it("come back as tasks with every field and their body, in the list file the export wrote", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 3, standaloneTasks: 5 }), async (spec) => {
      const { before, after, zip, report } = await trip(spec);
      expect(listPaths(zip)).toEqual(["任務/任務.md"]);
      expect(standalone(after.tasks)).toEqual(standalone(before.tasks));
      expect(report.tasks_imported).toBe(spec.tasks!.length);
      // The list is tasks, not a note: neither it nor a task's note file is a note of the new workspace.
      // (A tag's page comes back as a plain note: the NEW failure in exportImportRoundTrip.property.test.ts.)
      const pages = new Set(tagPageTitles(zip));
      expect(after.notes.map((n) => n.title).filter((title) => !pages.has(title)).sort()).toEqual(before.notes.filter((n) => !n.deleted).map((n) => n.title).sort());
      // Every one of them is a live task of the new workspace, in a space of its owner.
      expect(after.tasks.filter((t) => t.host === null).every((t) => !t.deleted)).toBe(true);
    }), roundTripRuns());
  }, 300_000);

  it("are left out of the export once in the trash", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 2, trashed: true, standaloneTasks: 5 }), async (spec) => {
      const { zip, after } = await trip(spec);
      const live = spec.tasks!.filter((t) => !t.trashed);
      expect(listPaths(zip).length).toBe(live.length ? 1 : 0);
      if (live.length) expect(parseTaskList([...zip].find(([n]) => n === "任務/任務.md")![1].toString("utf8")).map((t) => t.titleWithLink || t.title).length).toBe(live.length);
      expect(standalone(after.tasks).map((t) => t.title).sort()).toEqual(live.map((t) => t.title).sort());
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  it("export again to the same list: the tasks and their fields are stable", async () => {
    await fc.assert(fc.asyncProperty(worldSpec({ maxNotes: 2, standaloneTasks: 4 }), async (spec) => {
      const { zip, b } = await trip(spec);
      const second = await exportMarkdown(b.ws, b.actor);
      const lines = (z: Map<string, Buffer>) => parseTaskList(z.get("任務/任務.md")!.toString("utf8"))
        .map((t) => ({ title: t.link ? t.title : t.titleWithLink, fields: t.fields, body: !!t.link })).sort((x, y) => (x.title < y.title ? -1 : 1));
      expect(lines(second)).toEqual(lines(zip));
    }), roundTripRuns({ maxRuns: 4 }));
  }, 300_000);

  it("use the English names for ?lang=en and still import as tasks", async () => {
    const spec = fc.sample(worldSpec({ maxNotes: 2, standaloneTasks: 3 }), { seed: roundTripRuns().seed })[0]!;
    const { zip, before, after } = await trip(spec, { lang: "en" });
    expect(listPaths(zip)).toEqual(["Tasks/Tasks.md"]);
    expect([...zip.keys()].some((name) => name.startsWith("任務/"))).toBe(false);
    expect(standalone(after.tasks)).toEqual(standalone(before.tasks));
  }, 120_000);
});
