import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import TagDescription from "../components/TagDescription";
import { api, type Tag } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";

// The tag page's 「功能」 row: 「技能 ×」 chips (the × takes one off), 「還沒開」 and the owner-only
// controls. A tag with none has no row, and nothing here adds one (2026-11-12). The description folds past three lines.

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

const reviewTag: Tag = { id: "review-tag", name: "review", color: "", schema_id: "review-tag", schema_module: "review", schema_extends: [], effective_modules: ["review"] };
const skillTag: Tag = { id: "skill-tag", name: "skill", color: "", schema_id: "skill-tag", schema_module: "skills", schema_extends: [], effective_modules: ["skills"] };
const plain: Tag = { id: "plain", name: "讀書", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const withSkill: Tag = { ...plain, schema_extends: ["skill-tag"], effective_modules: ["skills"], functions: [{ id: "skills", source_tag_id: "skill-tag", ref_id: "ref-skills" }] };

let extendsBodies: unknown[]; // [method, function id] of each function write
beforeEach(() => {
  extendsBodies = [];
  resetAppState();
  setAppState((s) => ({ data: { ...s.data, tags: [plain, reviewTag, skillTag], actor_role: "admin", actor_is_owner: true,
    workspace: { ...s.data.workspace, modules: ["review", "skills", "tasks"], modules_to_confirm: [] } } }));
  vi.mocked(api).mockReset().mockImplementation(async (path, init) => {
    if (path === "/api/tags") return [{ ...plain, schema_fields: [], schema_behaviour: {} }] as never;
    if (path.includes("/functions/")) { const id = decodeURIComponent(path.split("/functions/")[1]!); extendsBodies.push([init?.method, id]); return { id: plain.id, function_id: id } as never; }
    return {} as never;
  });
});
afterEach(() => resetAppState());

const row = () => screen.getByRole("group", { name: "Functions" });

describe("the 功能 row", () => {
  it("with no functions draws no row at all, for the owner too", () => {
    render(<SchemaLens tag={plain} online canManage allTags={[plain, reviewTag, skillTag]} />);
    expect(screen.queryByRole("group", { name: "Functions" })).toBeNull();
    expect(screen.queryByText(/Add function/)).toBeNull();
  });

  it("the old #技能 inheritance now reads as the 技能 function, removable like any other", async () => {
    render(<SchemaLens tag={withSkill} online canManage allTags={[withSkill, reviewTag, skillTag]} />);
    expect(within(row()).getByText("Skills")).toBeInTheDocument();
    expect(screen.queryByText("Old inheritance")).toBeNull();
    // The raw tag name is never shown.
    expect(screen.queryByText("#skill")).toBeNull();
    fireEvent.click(within(row()).getByRole("button", { name: /Remove “Skills” from #讀書/ }));
    await waitFor(() => expect(extendsBodies).toEqual([["DELETE", "skills"]]));
  });

  it("a member sees the function but no ×", () => {
    render(<SchemaLens tag={withSkill} online allTags={[withSkill, reviewTag, skillTag]} />);
    expect(within(row()).getByText("Skills")).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("a function on this tag through its own module tag has no ×", () => {
    render(<SchemaLens tag={skillTag} online canManage allTags={[plain, reviewTag, skillTag]} />);
    expect(within(row()).getByText("Skills")).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: /Remove/ })).toBeNull();
  });
});

describe("the description folds past three lines", () => {
  const long = "一\n二\n三\n四\n五";
  it("shows 展開, then the full text with 收起; a short one has no toggle", () => {
    const { rerender } = render(<TagDescription markdown={long} canEdit={false} onSave={vi.fn()} />);
    const text = screen.getByText(/一/);
    expect(text).toHaveClass("is-folded");
    fireEvent.click(screen.getByRole("button", { name: "Unfold description" }));
    expect(text).not.toHaveClass("is-folded");
    expect(screen.getByRole("button", { name: "Fold description" })).toBeInTheDocument();
    rerender(<TagDescription markdown="短短一句" canEdit={false} onSave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /description/ })).toBeNull();
  });

  it("for the owner, pressing the text still edits it and the toggle only folds", () => {
    const onSave = vi.fn();
    render(<TagDescription markdown={long} canEdit onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Unfold description" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit the description" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
