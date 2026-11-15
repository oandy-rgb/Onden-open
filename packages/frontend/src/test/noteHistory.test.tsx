import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteHistory } from "../components/history";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { MAX_TICKS, type NoteHistoryVersion } from "../lib/history";

const h = vi.hoisted(() => ({
  restore: vi.fn(), editText: vi.fn(), flush: vi.fn(), create: vi.fn(), versions: vi.fn(), inkEdits: vi.fn(), inkChange: vi.fn(),
}));
vi.mock("../hooks/useVersionRestore", () => ({ useVersionRestore: () => ({ restore: h.restore, restoringVersionId: null, feedback: null }) }));
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => ({ user: { id: "u1", name: "Me" } }) }));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  drafts: { editText: h.editText, flush: h.flush },
  noteWriter: { create: h.create },
  reads: { notes: { versions: h.versions, inkEdits: h.inkEdits, inkChange: h.inkChange } },
}));

const node: ContentNode = { id: "n1", title: "Plan", slug: "plan", markdown: "", source_type: "manual", node_type: "content", parent_id: "p1" };
const NOW_BODY = "# Todo\n\nBuy milk\n\nAdded later";
// newest first, as the server sends it
const versions: NoteHistoryVersion[] = [
  { id: "v3", title: "Plan", markdown: "# Todo\n\nBuy oat milk\n\nAdded later", changed_at: "2026-09-03T08:00:00Z", actor_name: "Helper", actor_type: "ai_agent" },
  { id: "v2", title: "Plan", markdown: "# Todo\n\nBuy milk", changed_at: "2026-09-02T08:00:00Z", actor_name: "Me", actor_type: "user" },
  { id: "v1", title: "Plan", markdown: "# Todo", changed_at: "2026-09-01T08:00:00Z", actor_name: "Me", actor_type: "user" },
];

function show(over: Partial<React.ComponentProps<typeof NoteHistory>> = {}) {
  const props = { node, versions, currentMarkdown: NOW_BODY, nodes: [node], online: true, onOpenNote: vi.fn(), onClose: vi.fn(), ...over };
  return { ...render(<NoteHistory {...props} />), props };
}
const slider = () => screen.getByRole("slider");
const at = () => slider().getAttribute("aria-valuenow");
/** The rail is 300px wide: x = 0 is the oldest version, x = 300 is now. */
function dragTo(xs: number[]) {
  const rail = document.querySelector(".nh-rail") as HTMLElement;
  rail.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 44, right: 300, bottom: 44, x: 0, y: 0, toJSON() {} });
  fireEvent.pointerDown(slider(), { clientX: xs[0], pointerId: 1 });
  for (const x of xs.slice(1)) fireEvent.pointerMove(slider(), { clientX: x, pointerId: 1 });
}
const label = () => document.querySelector(".nh-label")!.textContent;

beforeAll(async () => { await import("../components/OverviewPreview"); });
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.versions.mockResolvedValue(versions);
  h.inkEdits.mockResolvedValue([]);
  h.flush.mockResolvedValue(true);
  h.editText.mockResolvedValue("applied");
  setLocalePref("en");
  resetAppState({ data: { ...noWorkspaceData, nodes: [node] }, selectedId: node.id, online: true });
});
afterEach(() => { cleanup(); resetAppState(); setLocalePref("system"); });

describe("note history slider", () => {
  it("opens on the newest stored version with its author and a plain summary", async () => {
    show();
    expect(at()).toBe("2");
    expect(slider()).toHaveAttribute("aria-valuemax", "3");
    expect(await screen.findByText("Buy oat milk")).toBeVisible();
    expect(within(document.querySelector(".nh-status") as HTMLElement).getByText("Helper")).toBeVisible();
    const sub = document.querySelector(".nh-status-sub")!;
    expect(sub).toHaveTextContent(/Added 1/);
    expect(sub).toHaveTextContent(/Changed 1/);
    expect(document.body.textContent).not.toMatch(/v3|n1/);
  });

  it("marks added, changed (with the struck old text) and removed paragraphs", async () => {
    const { container } = show({ initialVersionId: "v3" });
    await screen.findByText("Buy oat milk");
    expect(container.ownerDocument.querySelector(".nh-p--added")).not.toBeNull();
    expect(container.ownerDocument.querySelector(".nh-p--changed del")).toHaveTextContent("Buy milk");
    fireEvent.keyDown(slider(), { key: "Home" });
    expect(await screen.findByText("Todo")).toBeVisible();
  });

  it("shows the selected person as 'You' for the signed-in user", async () => {
    show({ initialVersionId: "v2" });
    await screen.findByText("Buy milk");
    expect(within(document.querySelector(".nh-status") as HTMLElement).getByText("You")).toBeVisible();
  });

  it("jumps to the end with the End key and lands on 'now' without marks or restore", async () => {
    show();
    fireEvent.keyDown(slider(), { key: "End" });
    expect(screen.getByRole("heading", { name: "How it looks now" })).toBeVisible();
    expect(document.querySelector(".nh-p--added, .nh-p--changed, .nh-p--removed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go back to this version" })).toBeNull();
    expect(screen.getByText("This is the version you are editing", { selector: ".nh-now-note" })).toBeVisible();
  });

  it("hold-to-see-now shows the present unmarked and returns on release", async () => {
    show({ initialVersionId: "v3" });
    await screen.findByText("Buy oat milk");
    const hold = screen.getByRole("button", { name: "Hold to see now" });
    fireEvent.pointerDown(hold);
    expect(screen.getByRole("heading", { name: "How it looks now" })).toBeVisible();
    expect(screen.getByText(/Release to go back to/)).toBeVisible();
    expect(document.querySelector(".nh-p--added, .nh-p--changed")).toBeNull();
    expect(await screen.findByText("Buy milk")).toBeVisible();
    fireEvent.pointerUp(hold);
    expect(screen.getByRole("heading", { name: /How it looked at/ })).toBeVisible();
    // the space bar holds too, and losing focus lets go
    fireEvent.keyDown(hold, { key: " " });
    expect(screen.getByRole("heading", { name: "How it looks now" })).toBeVisible();
    fireEvent.keyUp(hold, { key: " " });
    expect(screen.getByRole("heading", { name: /How it looked at/ })).toBeVisible();
    fireEvent.pointerDown(hold);
    fireEvent.pointerLeave(hold);
    expect(screen.getByRole("heading", { name: /How it looked at/ })).toBeVisible();
  });

  it("lists all versions newest first, frames the current one, and jumps on a click", async () => {
    show({ initialVersionId: "v3" });
    fireEvent.click(screen.getByRole("button", { name: "All versions" }));
    expect(document.querySelector(".nh-versions--open")).not.toBeNull();
    const list = within(screen.getByRole("complementary", { name: "All versions" }));
    const rows = list.getAllByRole("button").filter((b) => b.classList.contains("nh-row"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Now");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    fireEvent.click(rows[3]);
    expect(at()).toBe("0");
    expect(document.querySelector(".nh-versions--open")).toBeNull();
  });
});

describe("smooth dragging and time marks", () => {
  it("shows the nearest version while the thumb is between two, and settles on it at release", async () => {
    show({ initialVersionId: "v3" });
    await screen.findByText("Buy oat milk");
    // 100px of 300 = a third of the way: 1 of 3 steps, i.e. v2
    dragTo([100]);
    expect(at()).toBe("1");
    expect(await screen.findByText("Buy milk")).toBeVisible();
    // 130px = 1.3 steps: still v2, but the thumb sits at 130px, not on the version
    dragTo([130]);
    expect(at()).toBe("1");
    expect((document.querySelector(".nh-thumb") as HTMLElement).style.getPropertyValue("--at")).toBe(`${(130 / 300) * 100}%`);
    fireEvent.pointerUp(slider(), { pointerId: 1 });
    expect((document.querySelector(".nh-thumb") as HTMLElement).style.getPropertyValue("--at")).toBe(`${(1 / 3) * 100}%`);
    expect(at()).toBe("1");
  });

  it("follows the pointer to the ends and stops there", () => {
    show({ initialVersionId: "v3" });
    dragTo([150, 999]);
    expect(at()).toBe("3");
    dragTo([-40]);
    expect(at()).toBe("0");
  });

  it("moves one version per arrow, page and edge key, and ignores them while saving a copy", () => {
    show({ initialVersionId: "v2" });
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(at()).toBe("2");
    fireEvent.keyDown(slider(), { key: "PageDown" });
    expect(at()).toBe("1");
    fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    fireEvent.keyDown(slider(), { key: "ArrowLeft" });
    expect(at()).toBe("0");
    fireEvent.keyDown(slider(), { key: "PageUp" });
    expect(at()).toBe("1");
    fireEvent.keyDown(slider(), { key: "End" });
    expect(at()).toBe("3");
  });

  it("keeps the spoken value as the version's time and author", () => {
    show({ initialVersionId: "v3" });
    expect(slider().getAttribute("aria-valuetext")).toMatch(/Helper/);
    fireEvent.keyDown(slider(), { key: "End" });
    expect(slider()).toHaveAttribute("aria-valuetext", "Now");
  });

  it("writes the shown version's time over the thumb, and 'Now' at the right end", () => {
    show({ initialVersionId: "v3" });
    expect(label()).toMatch(/Sep 3/);
    dragTo([100]);
    expect(label()).toMatch(/Sep 2/);
    fireEvent.keyDown(slider(), { key: "End" });
    expect(label()).toBe("Now");
  });

  it("draws a dot for every version, marks the one being looked at and the AI's", () => {
    show({ initialVersionId: "v2" });
    const ticks = document.querySelectorAll(".nh-tick");
    expect(ticks).toHaveLength(4);
    expect(document.querySelectorAll(".nh-tick--current")).toHaveLength(1);
    expect(ticks[1]).toHaveClass("nh-tick--current");
    expect(ticks[2]).toHaveClass("nh-tick--agent");
    expect(ticks[3]).toHaveClass("nh-tick--now");
  });

  it("draws only a sample of the dots when there are very many versions", () => {
    const many: NoteHistoryVersion[] = Array.from({ length: 300 }, (_, i) => ({
      id: `m${300 - i}`, title: "Plan", markdown: `# ${300 - i}`, changed_at: new Date(Date.UTC(2026, 0, 1) + (299 - i) * 3600_000).toISOString(), actor_name: "Me", actor_type: "user",
    }));
    show({ versions: many, initialVersionId: "m150" });
    const ticks = document.querySelectorAll(".nh-tick");
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
    expect(ticks.length).toBeGreaterThan(10);
    expect(document.querySelectorAll(".nh-tick--current")).toHaveLength(1);
    expect(ticks[0]).toBeDefined();
    expect(document.querySelector(".nh-tick--now")).not.toBeNull();
  });
});

describe("take back one paragraph", () => {
  it("writes only that paragraph into the note through the editor's save path", async () => {
    show({ initialVersionId: "v3" });
    fireEvent.click((await screen.findByText("Buy oat milk")).closest(".nh-p")!);
    const panel = screen.getByRole("region", { name: "Take back just this paragraph" });
    expect(within(panel).getByText("Buy oat milk")).toBeVisible();
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Take back this paragraph" })); });
    expect(h.editText).toHaveBeenCalledOnce();
    const [id, edit] = h.editText.mock.calls[0];
    expect(id).toBe("n1");
    expect(edit(NOW_BODY)).toBe("# Todo\n\nBuy oat milk\n\nAdded later");
    expect(h.flush).toHaveBeenCalled();
    expect(await screen.findByText("Took back that paragraph")).toBeVisible();
  });

  it("says so when the paragraph already matches the note", async () => {
    show({ initialVersionId: "v3" });
    fireEvent.click((await screen.findByText("Added later")).closest(".nh-p")!);
    expect(screen.getByText("This paragraph is the same as now.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Take back this paragraph" })).toBeNull();
  });

  it("keeps the panel open when the save is refused", async () => {
    h.editText.mockResolvedValue("refused");
    show({ initialVersionId: "v3" });
    fireEvent.click((await screen.findByText("Buy oat milk")).closest(".nh-p")!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Take back this paragraph" })); });
    expect(screen.getByRole("region", { name: "Take back just this paragraph" })).toBeVisible();
    expect(screen.queryByText("Took back that paragraph")).toBeNull();
  });
});

describe("restore, undo and save as new note", () => {
  it("restores through the shared restore, jumps to now, and undo restores the version before", async () => {
    h.restore.mockResolvedValue({ status: "applied", message: "ok" });
    const afterRestore: NoteHistoryVersion[] = [
      { id: "v4", title: "Plan", markdown: "# Todo", changed_at: "2026-09-04T08:00:00Z", actor_name: "Me", actor_type: "user", markers: ["restored"], restored_from: "v1" },
      { id: "v3b", title: "Plan", markdown: NOW_BODY, changed_at: "2026-09-03T09:00:00Z", actor_name: "Me", actor_type: "user" },
      ...versions,
    ];
    h.versions.mockResolvedValueOnce(versions).mockResolvedValue(afterRestore);
    show({ initialVersionId: "v1" });
    await screen.findByText("Todo");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go back to this version" })); });
    expect(h.restore).toHaveBeenCalledExactlyOnceWith("n1", "v1", { restoreTitle: false });
    expect(at()).toBe(String(afterRestore.length));
    expect(screen.getByText(/Went back to the version of/)).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo restore" })); });
    expect(h.restore).toHaveBeenLastCalledWith("n1", "v3b", { restoreTitle: true });
    expect(screen.getByText("Undone")).toBeVisible();
  });

  describe("a version whose title differs from the note's", () => {
    const renamedNode: ContentNode = { ...node, title: "Final report" };
    // Oldest first: v1 "Draft" · v2 renamed to "Final report" with the same text · v3 new text.
    const renamed: NoteHistoryVersion[] = [
      { id: "v3", title: "Final report", markdown: "B", changed_at: "2026-09-03T08:00:00Z", actor_name: "Me", actor_type: "user" },
      { id: "v2", title: "Final report", markdown: "A", changed_at: "2026-09-02T08:00:00Z", actor_name: "Me", actor_type: "user" },
      { id: "v1", title: "Draft", markdown: "A", changed_at: "2026-09-01T08:00:00Z", actor_name: "Me", actor_type: "user" },
    ];
    const open = (initialVersionId: string) => {
      h.versions.mockResolvedValue(renamed);
      return show({ node: renamedNode, nodes: [renamedNode], versions: renamed, currentMarkdown: "B", initialVersionId });
    };

    it("names the older title on the shown version and on its row, and not on versions titled as now", async () => {
      open("v1");
      await screen.findByText("A");
      const rows = [...document.querySelectorAll(".nh-versions li")].map((li) => li.textContent ?? "");
      expect(rows.filter((r) => r.includes("Title: Draft"))).toHaveLength(1);
      expect(rows.some((r) => r.includes("Title: Final report"))).toBe(false);
      expect(document.querySelector(".nh-status")!.textContent).toContain("Title: Draft");
    });

    it("reads a rename-only point as a rename, not as no change to the text", async () => {
      open("v2");
      await screen.findByText("A");
      expect(document.querySelector(".nh-status")!.textContent).toContain("Renamed from “Draft”");
      expect(document.querySelector(".nh-status")!.textContent).not.toContain("No change to the text");
    });

    it("asks about the title first: text only by default, nothing is restored until it is confirmed", async () => {
      h.restore.mockResolvedValue({ status: "applied", message: "ok" });
      open("v1");
      await screen.findByText("A");
      fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
      const dialog = screen.getByTestId("restore-version-dialog");
      expect(h.restore).not.toHaveBeenCalled();
      const box = within(dialog).getByRole("checkbox", { name: "Also change the title back to “Draft”" });
      expect(box).not.toBeChecked();
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Go back to this version" })); });
      expect(h.restore).toHaveBeenCalledExactlyOnceWith("n1", "v1", { restoreTitle: false });
      expect(screen.queryByTestId("restore-version-dialog")).toBeNull();
    });

    it("restores the title too when the box is ticked", async () => {
      h.restore.mockResolvedValue({ status: "applied", message: "ok" });
      open("v1");
      await screen.findByText("A");
      fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
      const dialog = screen.getByTestId("restore-version-dialog");
      fireEvent.click(within(dialog).getByRole("checkbox"));
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Go back to this version" })); });
      expect(h.restore).toHaveBeenCalledExactlyOnceWith("n1", "v1", { restoreTitle: true });
    });

    it("restores nothing when the question is cancelled", async () => {
      open("v1");
      await screen.findByText("A");
      fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
      fireEvent.click(within(screen.getByTestId("restore-version-dialog")).getByRole("button", { name: "Cancel" }));
      expect(h.restore).not.toHaveBeenCalled();
      expect(screen.queryByTestId("restore-version-dialog")).toBeNull();
    });
  });

  it("keeps the screen where it is and shows the reason when the restore is refused", async () => {
    h.restore.mockResolvedValue({ status: "refused", message: "Try again later" });
    show({ initialVersionId: "v1" });
    await screen.findByText("Todo");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go back to this version" })); });
    expect(screen.getByText("Try again later")).toBeVisible();
    expect(at()).toBe("0");
  });

  it("needs a connection to go back, but not to save a copy", async () => {
    show({ online: false, initialVersionId: "v1" });
    expect(screen.getByRole("button", { name: "Go back to this version" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as new note" })).toBeEnabled();
  });

  it("saves the shown version as a note beside the original and offers to open it", async () => {
    h.create.mockResolvedValue({ status: "synced", node: { ...node, id: "copy" } });
    const { props } = show({ initialVersionId: "v2" });
    await screen.findByText("Buy milk");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save as new note" })); });
    expect(h.create).toHaveBeenCalledOnce();
    const input = h.create.mock.calls[0][0];
    expect(input).toMatchObject({ markdown: "# Todo\n\nBuy milk", parent_id: "p1" });
    expect(input.title).toMatch(/^Plan（.+）$/);
    fireEvent.click(screen.getByRole("button", { name: "Open note" }));
    expect(props.onOpenNote).toHaveBeenCalledWith("copy");
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("note history save as new note failure", () => {
  it("says so when the copy could not be created, and keeps the button usable", async () => {
    h.create.mockRejectedValueOnce(new Error("boom: 500"));
    const { props } = show({ initialVersionId: "v2" });
    await screen.findByText("Buy milk");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save as new note" })); });
    expect(screen.getByRole("status")).toHaveTextContent(/couldn.t|could not|failed/i);
    expect(document.body.textContent).not.toMatch(/boom/);
    expect(screen.queryByRole("button", { name: "Open note" })).toBeNull();
    expect(props.onOpenNote).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save as new note" })).toBeEnabled();
  });
});

describe("note history inline (the History page's right column)", () => {
  const showInline = (over: Partial<React.ComponentProps<typeof NoteHistory>> = {}) =>
    show({ inline: true, onClose: undefined, versions: [], onChanged: vi.fn(), ...over });

  it("has no dialog and no back button, and opens the note from a button at the top", async () => {
    const { props } = showInline();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open note" }));
    expect(props.onOpenNote).toHaveBeenCalledExactlyOnceWith("n1");
  });

  it("is the same slider: it reads the versions and opens on the end of the asked day", async () => {
    showInline({ initialDay: "2026-09-02" });
    expect(await screen.findByText("Buy milk")).toBeVisible();
    expect(at()).toBe("1");
    expect(slider()).toHaveAttribute("aria-valuemax", "3");
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(await screen.findByText("Buy oat milk")).toBeVisible();
    // the list of every version, hold-to-see-now and the actions are all still here
    expect(screen.getByRole("button", { name: "All versions" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hold to see now" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save as new note" })).toBeVisible();
  });

  it("says it is loading until the versions arrive, not 'no text'", async () => {
    h.versions.mockReturnValue(new Promise(() => {}));
    showInline();
    expect(screen.getByText("Loading…")).toBeVisible();
    expect(screen.queryByText("This version has no text.")).toBeNull();
  });

  it("says the versions could not be loaded, with Try again, instead of showing an empty history", async () => {
    h.versions.mockRejectedValueOnce(new Error("network down"));
    showInline();
    expect(await screen.findByText(/Couldn't load the history\./)).toBeVisible();
    expect(screen.queryByText("This version has no text.")).toBeNull();
    expect(document.body.textContent).not.toMatch(/network down/);
    h.versions.mockResolvedValueOnce(versions);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Buy milk")).toBeVisible();
    expect(screen.queryByText(/Couldn't load the history\./)).toBeNull();
  });

  it("shows Loading, not 'no text', while Try again reads the versions again", async () => {
    h.versions.mockRejectedValueOnce(new Error("network down"));
    show({ versions: [], inline: false });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    h.versions.mockReturnValue(new Promise(() => {}));
    expect(screen.queryByText("This version has no text.")).toBeNull();
    expect(screen.queryByText(/Couldn't load the history/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeVisible();
  });

  it("offline, Try again goes back to the connection message instead of sticking on Loading", async () => {
    h.versions.mockRejectedValueOnce(new Error("network down"));
    const { rerender, props } = show({ versions: [], inline: false });
    await screen.findByRole("button", { name: "Try again" });
    resetAppState({ data: { ...noWorkspaceData, nodes: [node] }, selectedId: node.id, online: false });
    rerender(<NoteHistory {...props} online={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Could not reach the server/)).toBeVisible();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("tells the page after a restore, so the list beside it reads again", async () => {
    h.restore.mockResolvedValue({ status: "applied", message: "" });
    const { props } = showInline({ initialVersionId: "v2" });
    await screen.findByText("Buy milk");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go back to this version" })); });
    expect(h.restore).toHaveBeenCalledExactlyOnceWith("n1", "v2", { restoreTitle: false });
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("tells the page after a copy is saved as a new note", async () => {
    h.create.mockResolvedValue({ node: { id: "copy" } });
    const { props } = showInline({ initialVersionId: "v2" });
    await screen.findByText("Buy milk");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save as new note" })); });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });
});
