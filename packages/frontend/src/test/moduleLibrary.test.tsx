import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppNavigation } from "../components/AppTopbar";
import ModuleLibrary from "../components/ModuleLibrary";
import ModuleSettingsPage from "../settings/ModuleSettingsPage";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
import { MODULES, importedModules, inModuleLibrary, moduleFilterFor, readingSectionsFor } from "../modules";
import { readWorkspaceModules, writeWorkspaceModules } from "../lib/workspaceMirror";
import { workspaceWriter } from "../lib/data/domainWriters";
import { api, type Tag } from "../lib/api";
import { usedFixture } from "./helpers/moduleUse";
// Online decisions check the local write queue first (onlineWrite.ts); jsdom has no DB worker.
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, workspaceWriter: { ...actual.workspaceWriter, setModuleImported: vi.fn() } };
});

function useWorkspace(modules: string[] | null | undefined, role: "admin" | "editor" = "admin") {
  resetAppState();
  setAppState((s) => ({ data: { ...s.data, actor_role: role, actor_is_owner: role === "admin", workspace: { ...s.data.workspace, modules } } }));
}

beforeEach(() => {
  vi.mocked(workspaceWriter.setModuleImported).mockReset();
  vi.mocked(api).mockReset().mockImplementation(async (path, init) => {
    if (path.endsWith("/extends")) return { id: path.split("/")[3], extends: JSON.parse(init!.body as string).extends } as never;
    return {} as never;
  });
});

const reviewTag: Tag = { id: "review-tag", name: "複習", color: "", schema_id: "review-tag",
  schema_module: "review", schema_extends: [], effective_modules: ["review"],
  schema_behaviour: { review: { new_per_day: 15, request_retention: 0.9, maximum_interval_days: 365 } } };
const course: Tag = { id: "course", name: "Course", color: "", schema_id: "course", schema_extends: ["review-tag"], effective_modules: ["review"] };
afterEach(() => resetAppState());

describe("module filter", () => {
  it("absent or null means every module (a workspace from before the library)", () => {
    expect(importedModules(moduleFilterFor(undefined))).toHaveLength(MODULES.length);
    expect(importedModules(moduleFilterFor(null))).toHaveLength(MODULES.length);
  });
  it("a recorded list keeps only those modules on every surface", () => {
    const only = moduleFilterFor(["rss"]);
    // The always-on ways of seeing (the whiteboard, slides, the view modules) stay, whatever the list says (2026-10-28/30, 2026-11-15).
    expect(importedModules(only).map((m) => m.id)).toEqual(["rss", "canvas", "slides", "table", "calendar", "kanban", "gallery"]);
    // RSS lives in the reading hub: its reader is the whole hub.
    expect(readingSectionsFor(only).map((s) => s.id)).toEqual(["rss"]);
  });
  it("round-trips through the local mirror", () => {
    expect(readWorkspaceModules(writeWorkspaceModules(["review", "rss"]))).toEqual(["review", "rss"]);
    expect(writeWorkspaceModules(undefined)).toBeNull();
    expect(readWorkspaceModules(null)).toBeNull();
    expect(readWorkspaceModules("not json")).toBeNull();
  });
});

describe("navigation follows the modules that are on and in use", () => {
  it("shows no Tags destination, and only the screens of functions in use", () => {
    useWorkspace(["tasks", "rss", "review"]);
    // A feed is subscribed; Review is on but nothing uses it yet.
    setAppState((s) => ({ data: { ...s.data, ...usedFixture(["rss"]) } }));
    render(<AppNavigation mode="notes" setMode={vi.fn()} onOpenModule={vi.fn()} onOpenFeature={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["Notes", "Tasks", "Graph", "Reading", "More"]);
  });
});

/** A feature's row in the list: found by the name it opens its page with. */
const rowOf = (title: string) => screen.getByText(title, { selector: ".module-row-name" }).closest("li")!;

describe("the feature list", () => {
  it("lists every built-in function as a row with a switch (no On / Off word); an owner turns one on", async () => {
    useWorkspace(["rss"]);
    vi.mocked(workspaceWriter.setModuleImported).mockResolvedValue({ modules: ["rss", "review"], moduleTagId: "review-tag" });
    render(<ModuleLibrary online />);
    const review = rowOf("Review");
    expect(within(review).queryByText("Off")).toBeNull();
    expect(within(review).getByRole("switch", { name: "Review" })).toHaveAttribute("aria-checked", "false");
    expect(within(rowOf("Reading")).getByRole("switch", { name: "Reading" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(review).getByRole("switch", { name: "Review" }));
    // Review has no module tag any more, so no tag name goes with the request.
    await waitFor(() => expect(workspaceWriter.setModuleImported).toHaveBeenCalledWith("review", true, true, undefined));
  });

  it("every feature the library ships has a row with a switch and a one-line sentence, and nothing says import", () => {
    useWorkspace(null);
    render(<ModuleLibrary online />);
    const rows = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-module"));
    const listed = MODULES.filter(inModuleLibrary);
    expect(rows.map((li) => li.getAttribute("data-module"))).toEqual(expect.arrayContaining(listed.map((m) => m.id)));
    // The always-on ways of seeing (views, the whiteboard) are chosen with 「＋」 on a page: no row.
    for (const mod of MODULES.filter((m) => !inModuleLibrary(m))) expect(rows.map((li) => li.getAttribute("data-module"))).not.toContain(mod.id);
    for (const mod of listed) expect(within(rowOf(mod.library.title)).getByRole("switch", { name: mod.library.title })).toBeChecked();
    const text = document.body.textContent ?? "";
    for (const old of ["Imported", "Not imported", "Import module", "Remove module", "Available to import", "引入", "匯入"]) expect(text).not.toContain(old);
    expect(screen.queryByRole("button", { name: /import module|imported/i })).toBeNull();
    // Under each name sits what the feature does, in one short sentence.
    for (const mod of listed) expect(rowOf(mod.library.title).querySelector(".module-row-blurb")?.textContent, mod.id).toBe(mod.library.blurb);
    expect(document.querySelector(".module-row-description, .module-library-note")).toBeNull();
  });

  it("a row opens that feature's page", () => {
    useWorkspace(null);
    const onOpenPage = vi.fn();
    render(<ModuleLibrary online onOpenPage={onOpenPage} />);
    fireEvent.click(rowOf("Review").querySelector(".module-row-open")!);
    expect(onOpenPage).toHaveBeenCalledWith("module:review");
  });

  it("the AI row opens Settings › AI, the one place for AI settings", () => {
    useWorkspace(null);
    const onOpenPage = vi.fn();
    render(<ModuleLibrary online onOpenPage={onOpenPage} />);
    fireEvent.click(rowOf("AI").querySelector(".module-row-open")!);
    expect(onOpenPage).toHaveBeenCalledWith("ai");
  });

  it("turning off asks first and says the data is kept", async () => {
    useWorkspace(["rss"]);
    vi.mocked(workspaceWriter.setModuleImported).mockResolvedValue({ modules: [], moduleTagId: null });
    render(<ModuleLibrary online />);
    const rss = rowOf("Reading");
    fireEvent.click(within(rss).getByRole("switch", { name: "Reading" }));
    expect(workspaceWriter.setModuleImported).not.toHaveBeenCalled();
    expect(within(rss).getByText(/Its data is kept/)).toBeInTheDocument();
    fireEvent.click(within(rss).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(workspaceWriter.setModuleImported).toHaveBeenCalledWith("rss", false, true, undefined));
  });

  it("a function that waits for its first yes asks once in plain words; yes turns it on, no changes nothing", async () => {
    useWorkspace(["review"]);
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules_to_confirm: ["rss", "semantic", "website"] } } }));
    vi.mocked(workspaceWriter.setModuleImported).mockResolvedValue({ modules: ["review", "rss"], moduleTagId: null });
    render(<ModuleLibrary online />);
    fireEvent.click(within(rowOf("Reading")).getByRole("switch", { name: "Reading" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn on “Reading”?")).toBeInTheDocument();
    expect(within(dialog).getByText(/RSS makes the server visit the websites you subscribe to/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(workspaceWriter.setModuleImported).not.toHaveBeenCalled();
    fireEvent.click(within(rowOf("Reading")).getByRole("switch", { name: "Reading" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(workspaceWriter.setModuleImported).toHaveBeenCalledWith("rss", true, true, undefined));
  });

  it("a function that already got its yes turns on again without asking", async () => {
    // Turned off after the owner agreed: it is not waiting for a yes.
    useWorkspace(["review"]);
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, modules_to_confirm: ["semantic", "website"] } } }));
    vi.mocked(workspaceWriter.setModuleImported).mockResolvedValue({ modules: ["review", "rss"], moduleTagId: null });
    render(<ModuleLibrary online />);
    fireEvent.click(within(rowOf("Reading")).getByRole("switch", { name: "Reading" }));
    await waitFor(() => expect(workspaceWriter.setModuleImported).toHaveBeenCalledWith("rss", true, true, undefined));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("groups rows by purpose under a heading, in a fixed order; a feature that is off stays in its group, quieter", () => {
    useWorkspace(["review", "rss"]);
    render(<ModuleLibrary online />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Search", "Time", "Reading and learning", "AI", "Present and publish"]);
    const blockOf = (title: string) => rowOf(title).closest(".module-group")!.getAttribute("data-section");
    expect(blockOf("Semantic search")).toBe("search");
    expect(blockOf("Review")).toBe("reading");
    expect(document.querySelector('[data-module="canvas"]')).toBeNull();
    // In the group's own order, on and off mixed: Reading comes before Review (no feature is named that is on its way out).
    const names = [...document.querySelectorAll('[data-section="reading"] .module-row-name')].map((n) => n.textContent);
    expect(names.indexOf("Reading")).toBeLessThan(names.indexOf("Review"));
    expect(rowOf("Semantic search")).toHaveClass("is-off");
    expect(rowOf("Review")).not.toHaveClass("is-off");
    // Nothing is piled at the bottom as a separate "off" block.
    expect(document.querySelector('.module-group[data-section="off"]')).toBeNull();
  });

  it("a dependent hangs under its host; with the host off it is dimmed, locked, and says what to turn on", () => {
    useWorkspace(["tasks", "skills"]);
    render(<ModuleLibrary online />);
    // AI is off, so skills (which need it) are off too, whatever they were set to.
    expect(rowOf("Skills")).toHaveClass("is-sub", "is-waiting");
    expect(within(rowOf("Skills")).getByRole("switch", { name: "Skills" })).toBeDisabled();
    expect(rowOf("Skills").querySelector(".module-row-blurb")).toHaveTextContent("Turn on AI first");
    expect(rowOf("AI").querySelector(".module-row-blurb")).toHaveTextContent("Off. Roles, connections and history are kept");
    expect(rowOf("AI")).not.toHaveClass("is-sub");
    // External calendars need the journal OR tasks: tasks is on, so it can be switched.
    expect(rowOf("External calendars")).toHaveClass("is-sub");
    expect(within(rowOf("External calendars")).getByRole("switch", { name: "External calendars" })).toBeEnabled();
    cleanup();
    useWorkspace(["review"]);
    render(<ModuleLibrary online />);
    expect(within(rowOf("External calendars")).getByRole("switch", { name: "External calendars" })).toBeDisabled();
    expect(rowOf("External calendars").querySelector(".module-row-blurb")).toHaveTextContent("Turn on Daily notes or Tasks first");
  });

  it("external calendars with neither journal nor tasks on are shown off, locked and not counted; back to what they were when one is on", () => {
    useWorkspace(["external_calendars"]);
    render(<ModuleLibrary online />);
    const toggle = () => within(rowOf("External calendars")).getByRole("switch", { name: "External calendars" });
    expect(toggle()).toBeDisabled();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(rowOf("External calendars")).toHaveAttribute("data-state", "off");
    cleanup();
    useWorkspace(["external_calendars", "tasks"]);
    render(<ModuleLibrary online />);
    expect(toggle()).toBeEnabled();
    expect(toggle()).toHaveAttribute("aria-checked", "true");
  });

  it("a member sees the AI row without a link or the pointer to Settings › AI; the owner gets both", () => {
    useWorkspace(null, "editor");
    const onOpenPage = vi.fn();
    render(<ModuleLibrary online onOpenPage={onOpenPage} />);
    const ai = rowOf("AI");
    expect(ai.querySelector(".module-row-open")).toBeDisabled();
    fireEvent.click(ai.querySelector(".module-row-open")!);
    expect(onOpenPage).not.toHaveBeenCalled();
    expect(ai).not.toHaveTextContent("Settings › AI");
    // Every other row still opens its page for a member.
    expect(rowOf("Review").querySelector(".module-row-open")).toBeEnabled();
    cleanup();
    useWorkspace(null);
    render(<ModuleLibrary online onOpenPage={onOpenPage} />);
    expect(rowOf("AI")).toHaveTextContent("Connections and roles are in Settings › AI");
    expect(rowOf("AI").querySelector(".module-row-open")).toBeEnabled();
  });

  it("when AI is on again, skills are back to what they were", () => {
    useWorkspace(["ai", "skills"]);
    render(<ModuleLibrary online />);
    expect(rowOf("Skills")).not.toHaveClass("is-waiting");
    const toggle = within(rowOf("Skills")).getByRole("switch", { name: "Skills" });
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
  });

  it("does not list 快速記錄 or 手寫: they cannot be turned off and are pages of Settings", () => {
    useWorkspace(null);
    render(<ModuleLibrary online />);
    for (const id of ["capture", "handwriting"]) expect(document.querySelector(`[data-module="${id}"]`), id).toBeNull();
  });

  it("a non-owner sees every switch disabled with a lock, and no sentence about it", () => {
    useWorkspace([], "editor");
    render(<ModuleLibrary online />);
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThan(0);
    for (const toggle of switches) expect(toggle).toBeDisabled();
    expect(screen.getAllByRole("img", { name: "Only the owner can change this" })).toHaveLength(switches.length);
    expect(screen.queryByText("The workspace owner can turn modules on or off.")).toBeNull();
    expect(getAppState().data.workspace.modules).toEqual([]);
  });
});

describe("a feature's page", () => {
  const ctx = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() };

  it("has the icon, the name and the master switch; 「在導覽列」; then 「打開」, which leaves Settings for it", async () => {
    useWorkspace(null);
    const heard = vi.fn();
    window.addEventListener("onden:open-feature", (e) => heard((e as CustomEvent).detail), { once: true });
    render(<ModuleSettingsPage id="review" ctx={ctx} />);
    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Review" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "In the navigation bar" })).toBeInTheDocument();
    // Nothing explains the feature in a sentence.
    expect(document.querySelector(".module-row-description")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Review" }));
    expect(ctx.onClose).toHaveBeenCalled();
    expect(heard).toHaveBeenCalledWith("review");
  });

  it("a feature that is off shows only its switch", () => {
    useWorkspace([]);
    render(<ModuleSettingsPage id="rss" ctx={ctx} />);
    expect(screen.getByRole("switch", { name: "Reading" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Open Reading" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "In the navigation bar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import subscriptions (.opml)" })).toBeNull();
  });

  it("turning the feature off from its page asks first, as the list does", async () => {
    useWorkspace(["rss"]);
    vi.mocked(workspaceWriter.setModuleImported).mockResolvedValue({ modules: [], moduleTagId: null });
    render(<ModuleSettingsPage id="rss" ctx={ctx} />);
    fireEvent.click(screen.getByRole("switch", { name: "Reading" }));
    expect(workspaceWriter.setModuleImported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(workspaceWriter.setModuleImported).toHaveBeenCalledWith("rss", false, true, undefined));
  });

  it("holds all of a feature's settings and nothing else: RSS's import, and none for Review (it has no tag to set)", async () => {
    useWorkspace(["review", "rss"]);
    setAppState((s) => ({ data: { ...s.data, tags: [reviewTag, course] } }));
    const { unmount } = render(<ModuleSettingsPage id="rss" ctx={ctx} />);
    expect(await screen.findByRole("button", { name: "Import subscriptions (.opml)" })).toBeInTheDocument();
    unmount();
    render(<ModuleSettingsPage id="review" ctx={ctx} />);
    expect(await screen.findByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /New cards per day/ })).toBeNull();
    expect(screen.queryByText(/These settings belong to/)).toBeNull();
  });

  it("the daily notes' page has the week strip, where new day notes go", async () => {
    useWorkspace(null);
    const { container } = render(<ModuleSettingsPage id="daily" ctx={ctx} />);
    await waitFor(() => expect(container.querySelector(".feature-preview--week")).not.toBeNull());
    expect(container.querySelectorAll(".feature-preview-day")).toHaveLength(7);
    // When the day starts is on Settings › Date and time now.
    expect(screen.queryByRole("combobox", { name: "When the day starts" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Where new day notes go" })).toBeInTheDocument();
  });

  it("the reading page draws two article rows", async () => {
    useWorkspace(["rss"]);
    const { container } = render(<ModuleSettingsPage id="rss" ctx={ctx} />);
    await waitFor(() => expect(container.querySelectorAll(".feature-preview-article")).toHaveLength(2));
  });

  it("a non-owner sees the switch disabled with a lock", () => {
    useWorkspace(["rss"], "editor");
    render(<ModuleSettingsPage id="rss" ctx={ctx} />);
    expect(screen.getByRole("switch", { name: "Reading" })).toBeDisabled();
    expect(screen.getByRole("img", { name: "Only the owner can change this" })).toBeInTheDocument();
  });
});

