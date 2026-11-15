// Standalone tasks (no host note) in the Markdown export and import
// (services/exportTasks.ts, modules/importers/markdown/taskLists.ts): who sees whose task
// in an export, a task's body files and what they carry, name clashes with
// notes, importing into the workspace the file came from, and the files that
// merely look like a task list.

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { freshWorkspace, snapshotWorkspace } from "./helpers/roundTripWorld.js";
import { exportMarkdown, importFiles, zipFiles } from "./helpers/roundTripApi.js";
import { tagPageTitles } from "./helpers/roundTripCompare.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { createStandaloneTask } from "../services/standaloneTasks.js";
import { createNote } from "../services/noteCreate.js";
import { storeMedia } from "../services/media.js";
import { parseTaskList } from "../services/taskListFile.js";

vi.mock("../db.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const enabled = isTestDatabase();
// The import checks task fields through the tasks module's seam, which the
// real app installs when it loads its modules.
registerShippedModules();

const listOf = (zip: Map<string, Buffer>, path = "任務/任務.md") => parseTaskList(zip.get(path)?.toString("utf8") ?? "");
const titles = (zip: Map<string, Buffer>) => listOf(zip).map((t) => t.title || t.titleWithLink).sort();
const allText = (zip: Map<string, Buffer>) => [...zip.values()].map((b) => b.toString("utf8")).join("\n");

describe.skipIf(!enabled)("the standalone task list in a Markdown export", () => {
  it("holds the tasks the exporting person may read, not another member's private ones", async () => {
    const { ws, actor: owner } = await freshWorkspace("task-priv");
    const member = await persistActor(ws, { id: "", name: "member", type: "human", role: "editor" });
    const shared = await makeSpace(ws, "Team", [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "edit" }]);
    const make = (actor: typeof owner, title: string, markdown: string, spaceId?: string) =>
      createStandaloneTask({ actor, workspaceId: ws, title, markdown, fields: { _task_status: "todo", _task_when: "2026-10-24" }, spaceId, uiContext: "test" });
    await make(owner, "owner private", "OWNER-SECRET-BODY");
    await make(member, "member private", "MEMBER-SECRET-BODY");
    await make(owner, "team task", "TEAM-BODY", shared);

    const asMember = await exportMarkdown(ws, member);
    expect(titles(asMember)).toEqual(["member private", "team task"]);
    expect(allText(asMember)).not.toContain("OWNER-SECRET-BODY");
    expect(allText(asMember)).toContain("MEMBER-SECRET-BODY");
    expect(allText(asMember)).toContain("TEAM-BODY");

    const asOwner = await exportMarkdown(ws, owner);
    expect(titles(asOwner)).toEqual(["owner private", "team task"]);
    expect(allText(asOwner)).not.toContain("MEMBER-SECRET-BODY");
  }, 60_000);

  it("is left out when the actor reads no standalone task", async () => {
    const { ws, actor } = await freshWorkspace("task-none");
    await createNote({ actor, workspaceId: ws, title: "just a note", markdown: "- [ ] a line task\n", event: { uiContext: "test" } });
    const zip = await exportMarkdown(ws, actor);
    expect([...zip.keys()].some((name) => name.startsWith("任務/"))).toBe(false);
  }, 60_000);

  it("names a task's note file after its title, never over a note's file, and links it from the line", async () => {
    const { ws, actor } = await freshWorkspace("task-names");
    // A note "任務" has its children in the folder the tasks use; one is named like a task, and two tasks share a title.
    const parent = await createNote({ actor, workspaceId: ws, title: "任務", markdown: "top\n", event: { uiContext: "test" } });
    await createNote({ actor, workspaceId: ws, title: "寫報告", markdown: "a note\n", parentId: String(parent.node.id), event: { uiContext: "test" } });
    const make = (title: string, markdown: string) => createStandaloneTask({ actor, workspaceId: ws, title, markdown, fields: {}, uiContext: "test" });
    await make("寫報告", "第一份");
    await make("寫報告", "第二份");
    await make("a/b: c?", "odd name");
    const zip = await exportMarkdown(ws, actor);

    expect(zip.get("任務/寫報告.md")!.toString("utf8")).toContain("a note");
    const lines = listOf(zip);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.link, line.titleWithLink).not.toBeNull();
      expect(zip.has(`${line.link}.md`), `${line.link}.md`).toBe(true);
    }
    expect(new Set(lines.map((l) => l.link!.toLowerCase())).size).toBe(3);
    expect(lines.filter((l) => l.title === "寫報告").every((l) => l.link !== "任務/寫報告")).toBe(true);
    expect(lines.find((l) => l.title === "a/b: c?")!.link).toBe("任務/a b c");

    // And the zip comes back with the same tasks and bodies.
    const b = await freshWorkspace("task-names-b");
    const report = await importFiles(b.ws, b.actor, zipFiles(zip));
    expect(report.tasks_imported).toBe(3);
    const after = await snapshotWorkspace(b.ws);
    expect(after.tasks.filter((t) => t.host === null).map((t) => [t.title, t.body]).sort()).toEqual([["a/b: c?", "odd name"], ["寫報告", "第一份"], ["寫報告", "第二份"]]);
    // (The #task tag's page comes back as a plain note, as every tag page does: exportImportRoundTrip.property.test.ts.)
    const pages = new Set(tagPageTitles(zip));
    expect(after.notes.map((n) => n.title).filter((title) => !pages.has(title)).sort()).toEqual(["任務", "寫報告"].sort());
  }, 60_000);

  it("carries a body's links and pictures like a note's file does", async () => {
    const { ws, actor } = await freshWorkspace("task-media");
    const target = await createNote({ actor, workspaceId: ws, title: "Target note", markdown: "t\n", event: { uiContext: "test" } });
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer();
    const stored = await storeMedia(png, ".png", { actor, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(stored.reason);
    await createStandaloneTask({
      actor, workspaceId: ws, title: "with refs", fields: {}, uiContext: "test",
      markdown: `See [the note](onden://node/${String(target.node.id)})\n\n![scan](/api/media/${stored.filename})\n`,
    });
    const zip = await exportMarkdown(ws, actor);
    const body = zip.get("任務/with refs.md")!.toString("utf8");
    expect(body).toContain("](../Target%20note.md)");
    expect(body).toContain(`](../attachments/${stored.filename})`);
    expect(zip.has(`attachments/${stored.filename}`)).toBe(true);

    const b = await freshWorkspace("task-media-b");
    await importFiles(b.ws, b.actor, zipFiles(zip));
    const [task] = (await snapshotWorkspace(b.ws)).tasks.filter((t) => t.host === null);
    expect(task!.body).toMatch(/!\[scan\]\(media:[0-9a-f]{12}\)/);
  }, 60_000);

  it("is matched by its reference when the same export is imported again as an update", async () => {
    const { ws, actor } = await freshWorkspace("task-again");
    const make = (title: string, when: string) => createStandaloneTask({ actor, workspaceId: ws, title, markdown: "", fields: { _task_when: when }, uiContext: "test" });
    await make("one", "2026-10-24");
    await make("two", "2026-10-25");
    const files = zipFiles(await exportMarkdown(ws, actor));
    const source = { id: randomUUID(), name: "again" };
    const first = await importFiles(ws, actor, files, source, { upsert: true });
    // Both are here already: nothing is made twice.
    expect(first).toMatchObject({ tasks_imported: 0, unchanged: 2 });
    const second = await importFiles(ws, actor, files, source);
    // Without update, a file is imported as it comes.
    expect(second.tasks_imported).toBe(2);
    expect((await snapshotWorkspace(ws)).tasks.filter((t) => t.host === null)).toHaveLength(4);
  }, 60_000);

  it("reads a list edited by hand in Obsidian: a new line, a moved line, a line with no reference", async () => {
    const { ws, actor } = await freshWorkspace("task-hand");
    const list = [
      "---", "onden_export: tasks", "---", "",
      "## 隨便", "",
      "- [ ] 手寫的 ⏳ 2026-12-25 📅 2026-12-31 🔁 every 2 weeks",
      "- [x] 完成的 ✅ 2026-10-01",
      "- [-] 取消的",
      "- not a task line",
      "", "## 另一段", "",
      "- [ ] 有代碼 [evening:: true] ^t-0123456789ab",
    ].join("\n");
    const report = await importFiles(ws, actor, [{ path: "任務/任務.md", content: list }]);
    expect(report.tasks_imported).toBe(4);
    const tasks = (await snapshotWorkspace(ws)).tasks.filter((t) => t.host === null).sort((a, b) => (a.title < b.title ? -1 : 1));
    const by = Object.fromEntries(tasks.map((t) => [t.title, t.attributes]));
    expect(by["手寫的"]).toEqual({ _task_status: "todo", _task_when: "2026-12-25", _task_deadline: "2026-12-31", _task_recur: "2w" });
    expect(by["完成的"]).toMatchObject({ _task_status: "done" });
    expect(by["完成的"]!._task_done_at).toBe("2026-10-01T12:00:00.000Z"); // from its ✅ day
    expect(by["取消的"]).toEqual({ _task_status: "cancelled" });
    expect(by["有代碼"]).toEqual({ _task_status: "todo", _task_evening: "true" });
  }, 60_000);

  it("imports a repeat Onden cannot run without it: years become months, other text is dropped and reported", async () => {
    const { ws, actor } = await freshWorkspace("task-recur");
    const list = [
      "---", "onden_export: tasks", "---", "",
      "- [ ] 每年 ⏳ 2026-12-25 🔁 every year",
      "- [ ] 兩年 ⏳ 2026-12-25 🔁 every 2 years",
      "- [ ] 太久 ⏳ 2026-12-25 🔁 every 100 years",
      "- [ ] 亂寫 ⏳ 2026-12-25 🔁 whenever I feel like it [remind_at:: soon]",
    ].join("\n");
    const report = await importFiles(ws, actor, [{ path: "任務/任務.md", content: list }]);
    expect(report.tasks_imported).toBe(4);
    expect(report.skipped).toBe(0);
    expect(report.task_fields_dropped).toHaveLength(2);
    expect(report.task_fields_dropped).toEqual(expect.arrayContaining([
      { path: "任務/任務.md", fields: ["recur"] },
      { path: "任務/任務.md", fields: expect.arrayContaining(["recur", "remind_at"]) },
    ]));
    const tasks = (await snapshotWorkspace(ws)).tasks.filter((t) => t.host === null);
    const by = Object.fromEntries(tasks.map((t) => [t.title, t.attributes]));
    expect(by["每年"]).toMatchObject({ _task_recur: "12m", _task_when: "2026-12-25" });
    expect(by["兩年"]).toMatchObject({ _task_recur: "24m" });
    for (const title of ["太久", "亂寫"]) {
      expect(by[title]).toBeDefined();
      expect(by[title]).not.toHaveProperty("_task_recur");
      expect(by[title]).toMatchObject({ _task_when: "2026-12-25" });
    }
    expect(by["亂寫"]).not.toHaveProperty("_task_remind_at");
  }, 60_000);

  it("leaves other files with checkboxes and Obsidian Tasks symbols as the notes they are", async () => {
    const { ws, actor } = await freshWorkspace("task-foreign");
    const plan = "# Plan\n\n- [ ] ship it ⏳ 2026-10-24 📅 2026-10-30 🔁 every week\n";
    const unmarked = "---\ntitle: 任務\n---\n\n- [ ] 一般筆記裡的勾選\n";
    const report = await importFiles(ws, actor, [
      { path: "Plan.md", content: plan },
      { path: "任務.md", content: unmarked },
    ]);
    expect(report).toMatchObject({ imported: expect.any(Number), tasks_imported: 0 });
    const after = await snapshotWorkspace(ws);
    expect(after.tasks.filter((t) => t.host === null)).toEqual([]);
    expect(after.notes.map((n) => n.title).sort()).toEqual(["Plan", "任務"]);
    expect(after.notes.find((n) => n.title === "Plan")!.body).toBe(plan);
  }, 60_000);

  it("refuses nothing quietly: a list over the size cap names its file in the conflicts", async () => {
    const { ws, actor } = await freshWorkspace("task-big");
    const huge = "x".repeat(2_000_001);
    const report = await importFiles(ws, actor, [
      { path: "任務/任務.md", content: "---\nonden_export: tasks\n---\n\n- [ ] big [[任務/big]] ^t-aaaaaaaaaaaa\n- [ ] fine ^t-bbbbbbbbbbbb\n" },
      { path: "任務/big.md", content: huge },
    ]);
    expect(report.tasks_imported).toBe(1);
    expect(report.conflicts).toEqual([{ path: "任務/任務.md", reason: "too_large" }]);
    expect(report.skipped).toBe(1);
  }, 60_000);
});
