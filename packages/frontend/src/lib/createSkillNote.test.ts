import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFrontmatter, fieldValue } from "@onden/markdown";
import type { ContentNode } from "./api";
import { getAppState } from "./appStore";
import { noteWriter } from "./data";
import { changeModuleImport } from "./moduleLibrary";
import { createSkillNote } from "./createSkillNote";

vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), noteWriter: { create: vi.fn() } }));
vi.mock("./moduleLibrary", () => ({ changeModuleImport: vi.fn() }));
vi.mock("./appStore", async (original) => {
  const real = await original<typeof import("./appStore")>();
  return { ...real, getAppState: vi.fn(real.getAppState), addToast: vi.fn() };
});

const created = (id = "n-1"): { status: "synced"; node: ContentNode } =>
  ({ status: "synced", node: { id, title: "t", markdown: "", node_type: "content" } as ContentNode });
const state = (modules: string[] | undefined, tags: object[] = []) => vi.mocked(getAppState).mockReturnValue(
  { online: true, data: { workspace: modules ? { modules } : {}, tags } } as unknown as ReturnType<typeof getAppState>);

beforeEach(() => {
  vi.mocked(noteWriter.create).mockReset().mockResolvedValue(created() as never);
  vi.mocked(changeModuleImport).mockReset().mockResolvedValue({ moduleTagId: "tag-new" });
});

describe("createSkillNote", () => {
  it("module imported: one note with the skills tag and the settings as frontmatter", async () => {
    state(["skills"], [{ id: "tag-skill", schema_module: "skills" }]);
    const openNode = vi.fn();
    const node = await createSkillNote(
      { title: " Reading notes ", instructions: "Summarize.", description: "Short", output: "note" }, { openNode });
    expect(node?.id).toBe("n-1");
    expect(changeModuleImport).not.toHaveBeenCalled();
    const sent = vi.mocked(noteWriter.create).mock.calls[0]![0];
    expect(sent).toMatchObject({ title: "Reading notes", tagIds: ["tag-skill"] });
    expect(sent.space_id).toBeUndefined(); // where new notes normally land
    const front = readFrontmatter(sent.markdown!)!;
    expect(fieldValue(front.entries, "description")).toBe("Short");
    expect(fieldValue(front.entries, "output")).toBe("note");
    expect(front.body.trim()).toBe("Summarize.");
    expect(openNode).toHaveBeenCalledWith("n-1");
  });

  it("made inside a note, it is created under that note", async () => {
    state(["skills"], [{ id: "tag-skill", schema_module: "skills" }]);
    await createSkillNote({ title: "A", instructions: "B" }, { parentId: "parent-1" });
    expect(vi.mocked(noteWriter.create).mock.calls[0]![0]).toMatchObject({ parent_id: "parent-1" });
  });

  it("module turned off: turns it on without asking, then creates with its tag", async () => {
    state(["review"], [{ id: "tag-skill", schema_module: "skills" }]);
    const node = await createSkillNote({ title: "A", instructions: "B" });
    expect(changeModuleImport).toHaveBeenCalledWith("skills", true, true);
    expect(vi.mocked(noteWriter.create).mock.calls[0]![0]).toMatchObject({ tagIds: ["tag-new"] });
    expect(node).not.toBeNull();
  });

  it("module on but its tag not made yet: makes the tag the first time it is needed", async () => {
    state(["skills"]);
    await createSkillNote({ title: "A", instructions: "B" });
    expect(changeModuleImport).toHaveBeenCalledWith("skills", true, true);
    expect(vi.mocked(noteWriter.create).mock.calls[0]![0]).toMatchObject({ tagIds: ["tag-new"] });
  });

  it("a refused write creates nothing and opens nothing", async () => {
    state(["skills"], [{ id: "tag-skill", schema_module: "skills" }]);
    vi.mocked(noteWriter.create).mockRejectedValue(new Error("refused"));
    const openNode = vi.fn();
    expect(await createSkillNote({ title: "A", instructions: "B" }, { openNode })).toBeNull();
    expect(openNode).not.toHaveBeenCalled();
  });
});
