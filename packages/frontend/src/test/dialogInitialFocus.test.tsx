// A dialog or popover with a text field to type in opens with the cursor in it; one without opens on its
// first action; the ✕ of the header is never where focus starts (components/ui/initialFocus.ts).
// setup.ts's showModal() stub moves focus like the browser's dialog focusing steps (to the first control),
// which is what put focus on the ✕ before this rule existed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal, SearchField, Sheet, SheetHeader, TextField } from "../components/ui";

const createQuickTask = vi.hoisted(() => vi.fn());
vi.mock("../modules/tasks/createQuickTask", () => ({ createQuickTask }));
vi.mock("../modules/rss/rssMutes", async (original) => ({ ...await original<typeof import("../modules/rss/rssMutes")>(), useRssMutes: () => ({ mutes: [], reload: async () => {} }) }));

import QuickAddSheet from "../modules/tasks/QuickAddSheet";
import RssSourcesSheet from "../modules/rss/RssSourcesSheet";
import RssSaveSheet from "../modules/rss/RssSaveSheet";
import { resetAppState } from "../lib/appStore";

beforeEach(() => { resetAppState(); createQuickTask.mockReset().mockResolvedValue({ saved: "saved", noteTitle: "today" }); });

describe("ui/Modal and ui/Sheet: where focus starts", () => {
  it("a field further down the card than the ✕ gets focus, with no autoFocus asked for", () => {
    render(<Sheet label="Name it" onClose={vi.fn()}><SheetHeader title="Name it" onClose={vi.fn()} /><TextField aria-label="Name" /><button type="button">Save</button></Sheet>);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("the main text field comes before buttons and selects that precede it", () => {
    render(<Modal label="Form" onClose={vi.fn()}>
      <div><SheetHeader title="Form" onClose={vi.fn()} /><button type="button">Help</button><input type="checkbox" aria-label="Flag" /><textarea aria-label="Note" /></div>
    </Modal>);
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveFocus();
  });

  it("a dialog with only buttons starts on its first action, not the ✕", () => {
    render(<Modal label="Choose" onClose={vi.fn()}><div><SheetHeader title="Choose" onClose={vi.fn()} /><button type="button">First</button><button type="button">Second</button></div></Modal>);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("a hidden or disabled field is not the main one", () => {
    render(<Modal label="Form" onClose={vi.fn()}>
      <div><SheetHeader title="Form" onClose={vi.fn()} /><input aria-label="Locked" disabled /><div hidden><input aria-label="Hidden" /></div><input aria-label="Real" /></div>
    </Modal>);
    expect(screen.getByRole("textbox", { name: "Real" })).toHaveFocus();
  });

  it("a field hidden by CSS (display:none) is skipped: the real one gets focus, not the ✕", () => {
    render(<Modal label="Form" onClose={vi.fn()}>
      <div><SheetHeader title="Form" onClose={vi.fn()} />
        <div style={{ display: "none" }}><input aria-label="Folded away" /></div>
        <input aria-label="Real" /></div>
    </Modal>);
    expect(screen.getByRole("textbox", { name: "Real", hidden: true })).toHaveFocus();
  });

  it("initialFocus still wins", () => {
    function Ask() {
      const yes = { current: null as HTMLButtonElement | null };
      return <Modal label="Ask" role="alertdialog" onClose={vi.fn()} initialFocus={yes}>
        <div><input aria-label="Name" /><button type="button" ref={(el) => { yes.current = el; }}>Yes</button></div>
      </Modal>;
    }
    render(<Ask />);
    expect(screen.getByRole("button", { name: "Yes" })).toHaveFocus();
  });

  it("closing returns focus to what opened it", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open</button>{open && <Modal label="M" onClose={() => setOpen(false)}><div><SheetHeader title="M" onClose={() => setOpen(false)} /><input aria-label="Name" /></div></Modal>}</>;
    }
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });
});

/** The screen is a touch screen (`pointer: coarse`); restored by vi.restoreAllMocks. */
function touchScreen(coarse: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: coarse && query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

describe("a search box on a touch screen", () => {
  afterEach(() => vi.restoreAllMocks());
  const search = () => <Sheet label="Pick" onClose={vi.fn()}><SheetHeader title="Pick" onClose={vi.fn()} /><SearchField label="Search places" value="" onValueChange={() => {}} /><button type="button">Top level</button></Sheet>;

  it("keeps the keyboard down: the cursor is not in the search box, and not on the ✕ either", () => {
    touchScreen(true);
    render(search());
    expect(screen.getByRole("searchbox", { name: "Search places" })).not.toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Pick" })).toHaveFocus();
  });

  it("holds for a full-page Modal too (the settings window), not only bottom sheets", () => {
    touchScreen(true);
    render(<Modal label="Page" onClose={vi.fn()}><div><SearchField label="Search settings" value="" onValueChange={() => {}} /></div></Modal>);
    expect(screen.getByRole("searchbox", { name: "Search settings" })).not.toHaveFocus();
  });

  it("with a mouse the search box has the cursor, as everywhere else", () => {
    touchScreen(false);
    render(search());
    expect(screen.getByRole("searchbox", { name: "Search places" })).toHaveFocus();
  });

  it("a text field the dialog exists to fill in still has the cursor on a touch screen", () => {
    touchScreen(true);
    render(<Sheet label="Name it" onClose={vi.fn()}><SheetHeader title="Name it" onClose={vi.fn()} /><TextField aria-label="Name" /></Sheet>);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it('initialFocus="dialog" puts focus on the dialog itself, whatever fields it has', () => {
    touchScreen(false);
    render(<Sheet label="Edit" onClose={vi.fn()} initialFocus="dialog"><SheetHeader title="Edit" onClose={vi.fn()} /><TextField aria-label="Title" /></Sheet>);
    expect(screen.getByRole("textbox", { name: "Title" })).not.toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Edit" })).toHaveFocus();
  });
});

describe("the dialogs with a main field", () => {
  it("新增任務: the box has focus, typing lands in it, Enter on an empty box does nothing and does not close", async () => {
    const onClose = vi.fn();
    render(<QuickAddSheet onClose={onClose} />);
    const box = await screen.findByRole("combobox", { name: "Task" });
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onClose).not.toHaveBeenCalled();
    expect(createQuickTask).not.toHaveBeenCalled();
    await userEvent.keyboard("buy milk{Enter}");
    await act(async () => {});
    expect(createQuickTask).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("RSS sources: the feed address box has focus; Enter on an empty box does nothing", async () => {
    const onClose = vi.fn();
    render(<RssSourcesSheet sources={[]} tags={[]} online quickTagIds={[]} onClose={onClose} onEdit={vi.fn()} onNotice={vi.fn()} onChangedFeeds={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /Feed URL/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("RSS 存到…: focus is on the destination's field, not the ✕", () => {
    render(<RssSaveSheet title="A post" defaultDestination={{ tagIds: [], parentId: null }} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(screen.queryByRole("button", { name: "Close" }));
    expect(document.activeElement?.tagName).toBe("INPUT");
  });
});
