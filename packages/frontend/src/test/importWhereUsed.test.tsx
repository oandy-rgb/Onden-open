import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import { pinImportedModule, useModuleImportConfirm } from "../components/ModuleImportConfirm";
import { api, type Tag } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { navLayoutStore } from "../lib/navLayoutStore";
import { parseNavLayout, type NavLayout } from "../lib/navLayout";
import { createSyncedPrefStore } from "../lib/syncedPrefStore";

// 內建功能預設全開 (docs/architecture/module-library.md): the tag page no longer
// adds functions (2026-11-12); a function it already holds whose module is off
// is turned on from its row. A function that waits for the owner's first yes (semantic search, RSS, website — here a TagFunction
// stand-in) asks once, always in plain words; the editor's # menu is in
// hashtagModuleSuggestions.test.tsx. Settings › Modules adjusts modules
// (moduleLibrary.test.tsx).

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

const reading: Tag = { id: "reading", name: "讀書", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const reviewTag: Tag = { id: "review-tag", name: "複習", color: "", schema_id: "review-tag",
  schema_module: "review", schema_extends: [], effective_modules: ["review"] };
const project: Tag = { id: "project", name: "複雜系統", color: "", schema_id: null, schema_extends: [], effective_modules: [] };

let calls: Array<{ path: string; body: unknown }>;
function workspace(modules: string[], { owner = true, toConfirm = [] }: { owner?: boolean; toConfirm?: string[] } = {}) {
  resetAppState();
  setAppState((s) => ({ data: { ...s.data, tags: [reading, reviewTag, project], actor_role: owner ? "admin" : "editor", actor_is_owner: owner,
    workspace: { ...s.data.workspace, modules, modules_to_confirm: toConfirm } } }));
}

beforeEach(() => {
  calls = [];
  vi.mocked(api).mockReset().mockImplementation(async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) as unknown : undefined;
    calls.push({ path, body });
    if (path === "/api/tags") return [{ ...reading, schema_fields: [], schema_behaviour: {} }] as never;
    if (path === "/api/workspace/modules") {
      const { module, imported } = body as { module: string; imported: boolean };
      const current = getAppState().data.workspace.modules ?? [];
      return { modules: imported ? [...current, module] : current.filter((id) => id !== module), module_tag_id: imported ? `${module}-tag` : undefined } as never;
    }
    if (path.includes("/functions/")) return { id: reading.id, function_id: decodeURIComponent(path.split("/functions/")[1]!) } as never;
    return {} as never;
  });
});
afterEach(() => { navLayoutStore.save(null); resetAppState(); });

const holding = (...ids: string[]): Tag => ({ ...reading, schema_extends: ids.map((id) => `${id}-tag`), effective_modules: ids,
  functions: ids.map((id) => ({ id, source_tag_id: `${id}-tag`, ref_id: `ref-${id}` })) });
const tagPage = (tag: Tag = reading) => render(<SchemaLens tag={tag} online canManage allTags={[tag, reviewTag, project]} />);
const dormantRow = (id: string) => within(screen.getByRole("group", { name: "Functions" })).getByText(
  (_, el) => el?.getAttribute("data-function") === id) as HTMLElement;
const moduleWrites = () => calls.filter((c) => c.path === "/api/workspace/modules");
const extendsWrites = () => calls.filter((c) => c.path.includes("/functions/"));

describe("a tag page no longer adds functions (2026-11-12)", () => {
  it("a tag with none has no Add button, no picker and no Functions row, even for the owner", () => {
    workspace(["review", "skills"]);
    tagPage();
    expect(screen.queryByRole("button", { name: /Add function/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Functions" })).toBeNull();
    expect(extendsWrites()).toHaveLength(0);
  });
});

describe("a function the tag already holds whose module is off", () => {
  it("one that waits for its first yes asks once, then offers one Undo", async () => {
    workspace(["review"], { toConfirm: ["skills"] });
    const tag = holding("skills");
    tagPage(tag);
    fireEvent.click(within(dormantRow("skills")).getByRole("button", { name: "Turn on" }));
    // Nothing is turned on before the person confirms.
    expect(moduleWrites()).toHaveLength(0);
    const dialog = await screen.findByRole("dialog", { name: "Turn on “Skills”?" });
    // The body comes from the module's own declaration.
    expect(within(dialog).getByRole("list", { name: "It adds" })).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "It can reach" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Then it is added to/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(extendsWrites()).toHaveLength(1));
    expect(moduleWrites().map((c) => c.body)).toEqual([{ module: "skills", imported: true, tag_name: "skill" }]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn on “Skills”?" })).toBeNull());
    const toast = getAppState().toasts.find((t) => t.message === "Turned on “Skills” and added it to #讀書")!;
    expect(toast.action?.label).toBe("Undo");
    toast.action!.onClick();
    await waitFor(() => expect(moduleWrites()).toHaveLength(2));
    expect(moduleWrites()[1]!.body).toEqual({ module: "skills", imported: false });
  });

  it("cancel changes nothing", async () => {
    workspace([], { toConfirm: ["skills"] });
    tagPage(holding("skills"));
    fireEvent.click(within(dormantRow("skills")).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on “Skills”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Turn on/ })).toBeNull());
    expect(moduleWrites()).toHaveLength(0);
    expect(extendsWrites()).toHaveLength(0);
    expect(getAppState().data.workspace.modules).toEqual([]);
  });

  it("someone who cannot decide for the workspace gets no turn-on button", () => {
    workspace(["review"], { owner: false, toConfirm: ["skills"] });
    tagPage(holding("skills"));
    expect(within(dormantRow("skills")).queryByRole("button", { name: "Turn on" })).toBeNull();
  });
});

/** The confirmation alone, as the editor host uses it. */
function Harness({ moduleId, run }: { moduleId: string; run: () => Promise<boolean> }) {
  const importer = useModuleImportConfirm();
  return <>
    <button type="button" onClick={() => void importer.confirm(moduleId, { run })}>ask</button>
    {importer.element}
  </>;
}

describe("the one-time confirmation", () => {
  it("offers nothing to press to someone who cannot decide, and says what it does", async () => {
    workspace([], { owner: false });
    const run = vi.fn(async () => true);
    render(<Harness moduleId="rss" run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on “Reading”?" });
    expect(within(dialog).getByText("Only the workspace owner can turn modules on.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Turn on" })).toBeNull();
    // The plain-words sentence first, then what it reaches: RSS connects to the feeds.
    expect(within(dialog).getByText(/RSS makes the server visit the websites you subscribe to/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Fetches the feeds you subscribe to/)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("says in plain words what each of the three does", async () => {
    workspace([]);
    for (const [id, title, sentence] of [
      ["semantic", "Semantic search", /uses an AI model on the server .* costs computing fees/],
      ["rss", "Reading", /visit the websites you subscribe to/],
      ["website", "Website", /publishes the notes in the spaces you choose to the public web/],
    ] as const) {
      const { unmount } = render(<Harness moduleId={id} run={vi.fn(async () => true)} />);
      fireEvent.click(screen.getByRole("button", { name: "ask" }));
      const dialog = await screen.findByRole("dialog", { name: `Turn on “${title}”?` });
      expect(within(dialog).getByText(sentence)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeInTheDocument();
      unmount();
    }
  });

  it("an unedited nav needs no pin; an edited one offers 也釘到導覽列 and pins after the yes", async () => {
    workspace([]);
    const run = vi.fn(async () => true);
    const { unmount } = render(<Harness moduleId="review" run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    let dialog = await screen.findByRole("dialog", { name: "Turn on “Review”?" });
    // Never edited (null): the default nav lists the page once it is in use.
    expect(within(dialog).queryByRole("checkbox", { name: /Also pin/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    unmount();

    navLayoutStore.save({ order: ["tasks", "tags"], phone: 2 });
    render(<Harness moduleId="review" run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    dialog = await screen.findByRole("dialog", { name: "Turn on “Review”?" });
    const pin = within(dialog).getByRole("checkbox", { name: /Also pin to the navigation bar/ });
    expect(pin).not.toBeChecked();
    fireEvent.click(pin);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navLayoutStore.get().value?.order).toEqual(["tasks", "tags", "review"]));
  });

  it("a module without a page of its own offers no pin", async () => {
    workspace([]);
    navLayoutStore.save({ order: ["tasks"], phone: 1 });
    render(<Harness moduleId="skills" run={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on “Skills”?" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });
});

describe("pinning after the yes", () => {
  function store(layout: NavLayout | null) {
    let held: unknown = { value: layout, dirty: false };
    return createSyncedPrefStore<NavLayout>(
      { load: async () => layout, save: async () => {} },
      { scope: () => "test", read: () => held, write: (value) => { held = value; } },
      parseNavLayout,
    );
  }

  it("on a phone with a full bar, goes on the desktop list after the phone's cut instead of asking for a swap", () => {
    const s = store({ order: ["tasks", "tags", "graph", "timeline"], phone: 3 });
    pinImportedModule("review", "phone", s);
    expect(s.get().value).toEqual({ order: ["tasks", "tags", "graph", "timeline", "review"], phone: 3 });
  });

  it("joins the phone bar when there is room", () => {
    const s = store({ order: ["tasks", "timeline"], phone: 1 });
    pinImportedModule("review", "phone", s);
    expect(s.get().value).toEqual({ order: ["tasks", "review", "timeline"], phone: 2 });
  });

  it("leaves a never-edited layout alone", () => {
    const s = store(null);
    pinImportedModule("review", "desktop", s);
    expect(s.get().value).toBeNull();
  });
});
