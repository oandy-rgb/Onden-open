import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import { api, ApiError, type ContentNode, type Tag } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { requestTagFields } from "../lib/tagPageRequest";
// Online decisions check the local write queue first (onlineWrite.ts); jsdom has no DB worker.
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

// The tag page's functions (docs/architecture/module-library.md): what notes
// with the tag get, as chips on the page (「複習 ×」); the owner adds one from
// its held functions as chips and takes one off with its ×. There is no structure panel and no
// list of old inheritances: a module tag is a function, and nothing makes a
// tag extend another user tag.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
const course: Tag = { id: "course", name: "Course", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const reviewTag: Tag = { id: "review-tag", name: "複習", color: "", schema_id: "review-tag",
  schema_module: "skills", schema_extends: [], effective_modules: ["skills"] };
const plain: Tag = { id: "plain", name: "Plain", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
/** The function reference the server sends for a tag that added Review. */
const REVIEW_REF = { id: "skills", source_tag_id: "review-tag", ref_id: "ref-review" };
const note = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({ id, title: id, slug: id, markdown: "", source_type: "manual", node_type: "content", ...extra });

let saveError: Error | null;
let saved: string[];
let removed: string[];
let moduleImports: Array<{ module: string; imported: boolean; tag_name?: string }>;
beforeEach(() => {
  resetAppState();
  const { data } = getAppState();
  setAppState({ data: { ...data, tags: [course, reviewTag, plain] } });
  saveError = null;
  saved = [];
  removed = [];
  moduleImports = [];
  vi.mocked(api).mockReset().mockImplementation(async (path, init) => {
    if (path === "/api/tags") return [{ ...course, schema_fields: [], schema_behaviour: {} }] as never;
    if (path.endsWith("/delete-preview")) return { fields: [] } as never;
    if (path === "/api/workspace/modules") {
      if (saveError) throw saveError;
      const body = JSON.parse(init!.body as string) as { module: string; imported: boolean; tag_name?: string };
      moduleImports.push(body);
      return { modules: ["skills"], module_tag_id: reviewTag.id } as never;
    }
    if (path.includes("/functions/")) {
      if (saveError) throw saveError;
      const functionId = decodeURIComponent(path.split("/functions/")[1]!);
      (init?.method === "DELETE" ? removed : saved).push(functionId);
      return { id: course.id, function_id: functionId } as never;
    }
    if (path.endsWith("/modules")) {
      if (saveError) throw saveError;
      return { id: course.id, behaviour: { modules: { skills: { enabled: false } } } } as never;
    }
    return {} as never;
  });
});

const page = (tag: Tag, props: Partial<Parameters<typeof SchemaLens>[0]> = {}) =>
  render(<SchemaLens tag={tag} online allTags={[course, reviewTag, plain]} {...props} />);
/** The page's own line of functions (everyone sees it). */
const functionLine = () => screen.getByRole("group", { name: "Functions" });
const removeButton = (name: string, tag = "Course") => within(functionLine()).getByRole("button", { name: `Remove “${name}” from #${tag}` });

describe("tag functions", () => {
  it("opens on the notes; a non-owner gets no controls and fills values in notes", () => {
    const onOpenNode = vi.fn();
    page(course, { onOpenNode, nodes: [
      note("Label member", { label_tag_ids: [course.id] }), note("Schema member", { class_tag_ids: [course.id] }),
      note("Hidden", { label_tag_ids: [course.id], hidden: true }),
      note("Tag node", { label_tag_ids: [course.id], node_type: "class_tag" }),
    ] });
    fireEvent.click(screen.getByRole("button", { name: "Label member" }));
    expect(onOpenNode).toHaveBeenCalledWith("Label member");
    expect(screen.getByRole("button", { name: "Schema member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hidden" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tag node" })).toBeNull();
    // A tag with no functions has no functions row for a non-owner (empty items stay out).
    expect(screen.queryByRole("group", { name: "Functions" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Fields" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add function" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("the owner's fields and functions are rows on the page itself — no panel — and the notes follow", () => {
    page(course, { canManage: true, nodes: [note("Member", { label_tag_ids: [course.id] })] });
    expect(screen.getByRole("group", { name: "Fields" })).toBeInTheDocument();
    // No function on the tag: no row, and nothing offers to add one (2026-11-12).
    expect(screen.queryByRole("group", { name: "Functions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add function" })).toBeNull();
    expect(screen.getByRole("button", { name: "Member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit structure" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saved).toEqual([]);
  });

  it("the × takes the function off by removing its reference, and says so", async () => {
    const extending = { ...course, schema_extends: [reviewTag.id, plain.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    page(extending, { canManage: true });
    fireEvent.click(removeButton("Skills"));
    await waitFor(() => expect(removed).toEqual(["skills"]));
    expect(getAppState().toasts.some((toast) => toast.message === "Removed “Skills”")).toBe(true);
  });

  it("a refused removal leaves the page as it was and says why", async () => {
    saveError = new ApiError(403, "forbidden");
    const onSaved = vi.fn();
    const extending = { ...course, schema_extends: [reviewTag.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    page(extending, { canManage: true, onSaved });
    fireEvent.click(removeButton("Skills"));
    await waitFor(() => expect(getAppState().toasts.some((toast) => toast.kind === "error"
      && toast.message === "You don't have permission to do that.")).toBe(true));
    expect(onSaved).not.toHaveBeenCalled();
    expect(within(functionLine()).getByText("Skills")).toBeInTheDocument();
  });

  it("a function the tag only shows through another tag's row (no reference of its own) cannot be taken off here", () => {
    const parent = { ...plain, id: "parent", name: "Parent", schema_extends: [reviewTag.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    const child = { ...course, schema_extends: [parent.id], effective_modules: ["skills"], functions: [{ id: "skills", source_tag_id: parent.id, ref_id: null }] };
    render(<SchemaLens tag={child} online canManage allTags={[child, reviewTag, parent]} />);
    expect(within(functionLine()).getByText("Skills")).toBeInTheDocument();
    expect(within(functionLine()).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("no UI makes a tag extend another user tag or pick a function for it", () => {
    render(<SchemaLens tag={course} online canManage allTags={[course, reviewTag, plain]} />);
    expect(screen.queryByRole("button", { name: "Add function" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /inherit/i })).toBeNull();
    expect(screen.queryByText(/Inherit a tag/)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saved).toEqual([]);
  });

  it("the module's own tag lists the notes of tags that extend it, and its function has no ×", () => {
    const child = { ...plain, id: "child", name: "Child", schema_extends: [reviewTag.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    render(<SchemaLens tag={reviewTag} online canManage allTags={[course, reviewTag, plain, child]} nodes={[
      note("Direct", { class_tag_ids: [reviewTag.id] }), note("Through child", { label_tag_ids: [child.id] }),
      note("Elsewhere", { label_tag_ids: [plain.id] }),
    ]} />);
    expect(screen.getByRole("button", { name: "Direct" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Through child" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();
    expect(screen.getByText("Includes notes of the tags that use this function: #Child")).toBeInTheDocument();
    // Its own function cannot be taken off here (remove the module instead).
    expect(within(functionLine()).getByText("Skills")).toBeInTheDocument();
    expect(within(functionLine()).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("a function the tag holds with its own settings shows as the tag's own and the × removes that reference", async () => {
    const own = { ...course, effective_modules: ["skills"], functions: [{ id: "skills", source_tag_id: course.id, ref_id: "ref-own" }] };
    page(own, { canManage: true });
    fireEvent.click(removeButton("Skills"));
    await waitFor(() => expect(removed).toEqual(["skills"]));
    // No extends list and no behaviour switch is written any more.
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/extends") || path.endsWith("/modules"))).toBe(false);
  });

  it("offline, nothing can be changed and the page says why", () => {
    const extending = { ...course, schema_extends: [reviewTag.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    page(extending, { canManage: true, online: false });
    expect(within(functionLine()).queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(screen.getByText("Connect to change functions.")).toBeInTheDocument();
  });

  it("a function whose module is not imported does nothing and says 還沒開; the owner turns it on", () => {
    const { data } = getAppState();
    setAppState({ data: { ...data, actor_role: "admin", actor_is_owner: true, workspace: { ...data.workspace, modules: [] } } });
    const extending = { ...course, schema_extends: [reviewTag.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    render(<SchemaLens tag={extending} online canManage allTags={[extending, reviewTag]} />);
    expect(screen.queryByRole("button", { name: "Start skills" })).toBeNull();
    expect(within(functionLine()).getByText("Not on yet")).toBeInTheDocument();
    expect(within(functionLine()).getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    expect(removeButton("Skills")).toBeInTheDocument();
    expect(moduleImports).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("a non-administrator sees a dormant function on the page, and nothing to change", () => {
    const { data } = getAppState();
    setAppState({ data: { ...data, workspace: { ...data.workspace, modules: [] } } });
    const extending = { ...course, schema_extends: [reviewTag.id], effective_modules: ["skills"], functions: [REVIEW_REF] };
    render(<SchemaLens tag={extending} online allTags={[extending, reviewTag]} />);
    expect(within(functionLine()).getByText("Not on yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    expect(within(functionLine()).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("the fields row lists inherited fields as plain chips, marked with the tag they come from", () => {
    const parent = { ...plain, id: "parent-f", name: "Book", schema_fields: [{ name: "finished", type: "date" }] } as Tag;
    const child = { ...course, schema_extends: [parent.id], schema_fields: [{ name: "pages", type: "number" }],
      effective_fields: [{ name: "pages", type: "number" }, { name: "finished", type: "date", inherited_from: parent.id }] } as Tag;
    render(<SchemaLens tag={child} online canManage allTags={[child, parent]} />);
    const row = screen.getByRole("group", { name: "Fields" });
    // Its own field opens its settings; the inherited one is read-only.
    expect(within(row).getByRole("button", { name: /pages$/ })).toBeInTheDocument();
    const inherited = within(row).getByTitle("from #Book");
    expect(inherited).toHaveTextContent("datefinished");
    expect(inherited.tagName).toBe("SPAN");
  });

  it("a view module's tag (#月曆) has no fields or functions to change: its page only gathers the tags that use the view", () => {
    const calendar: Tag = { id: "calendar", name: "月曆", color: "", schema_id: "calendar", schema_module: "calendar", view_module: true, schema_extends: [], effective_modules: [] };
    requestTagFields(calendar.id);
    render(<SchemaLens tag={calendar} online canManage allTags={[course, reviewTag, calendar]} />);
    expect(screen.queryByRole("button", { name: "Add function" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Fields" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add field" })).toBeNull();
    // An ordinary tag has the fields row.
    cleanup();
    page(course, { canManage: true });
    expect(screen.getByRole("button", { name: "Add field" })).toBeInTheDocument();
  });

  it("「移到另一個標籤底下」 is in the ⋯ menu and offers tags only — not the tag itself, one under it, or a function", async () => {
    const child = { ...plain, id: "child", name: "Child", parent_id: course.id };
    const { data } = getAppState();
    setAppState({ online: true, data: { ...data, nodes: [note(course.id, { node_type: "class_tag" })] } });
    render(<SchemaLens tag={course} online canManage allTags={[course, reviewTag, plain, child]} nodes={[note("Some note")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Move under another tag/ }));
    const select = within(screen.getByRole("region", { name: "Move under another tag" })).getByRole("combobox", { name: "Parent tag" });
    const options = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(options[0]).toBe("None (top level)");
    expect(options.slice(1)).toEqual(["#Plain"]); // 複習 is a function: no tag goes under it
    fireEvent.change(select, { target: { value: plain.id } });
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, init]) => path === `/api/nodes/${course.id}`
      && JSON.parse(init!.body as string).parent_id === plain.id)).toBe(true));
  });
});
