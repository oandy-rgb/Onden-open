// The one date picker (components/ui/DatePicker) and the four places that use it:
// typing, the month grid, the quick picks, the keyboard, clear, the phone's bottom sheet,
// and that each caller still saves exactly the value the native input used to.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatePicker } from "../components/ui";
import TaskSheet from "../modules/tasks/TaskSheet";
import { SchemaRow } from "../components/attributes/SchemaRow";
import type { TaskItem } from "../lib/tasks";

vi.mock("../hooks/useToday", () => ({ useToday: () => TODAY }));
const TODAY = "2026-10-29"; // a Thursday

function setPhone(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => setPhone(false));
afterEach(() => vi.restoreAllMocks());

const cell = (day: string) => document.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)!;

describe("DatePicker panel", () => {
  it("reads typed words with the shared reader and picks on Enter", async () => {
    const onChange = vi.fn();
    render(<DatePicker inline value={null} today={TODAY} label="Which day" onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "Type a date" });
    await userEvent.type(box, "明天");
    expect(screen.getByRole("status")).toHaveTextContent(/Oct 30, 2026/);
    await userEvent.type(box, "{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-10-30");
    await userEvent.clear(box);
    await userEvent.type(box, "下週三{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-04");
    await userEvent.clear(box);
    await userEvent.type(box, "11/3{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-03");
  });

  it("keeps what was typed and says so when it is not a day", async () => {
    const onChange = vi.fn();
    render(<DatePicker inline value={null} today={TODAY} label="Which day" onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "Type a date" });
    await userEvent.type(box, "soon-ish{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(box).toHaveValue("soon-ish");
    expect(box).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("Can't read that as a day");
  });

  it("picks from the month grid, of the workspace's month", async () => {
    const onChange = vi.fn();
    render(<DatePicker inline value={null} today={TODAY} label="Which day" onChange={onChange} />);
    expect(cell(TODAY)).toHaveAttribute("aria-current", "date");
    await userEvent.click(cell("2026-10-31"));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-31");
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await userEvent.click(cell("2026-11-15"));
    expect(onChange).toHaveBeenLastCalledWith("2026-11-15");
  });

  it("has Today / Tomorrow / Next week, and Clear only when there is a day", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<DatePicker inline clearable value={null} today={TODAY} label="Which day" onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-29");
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-30");
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-11-02");
    rerender(<DatePicker inline clearable value="2026-11-02" today={TODAY} label="Which day" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("moves with the arrow keys, PageUp/PageDown, and picks with Enter", async () => {
    const onChange = vi.fn();
    render(<DatePicker inline value="2026-10-29" today={TODAY} label="Which day" onChange={onChange} />);
    cell("2026-10-29").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(cell("2026-10-30")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(cell("2026-11-06")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowUp}");
    expect(cell("2026-10-29")).toHaveFocus();
    await userEvent.keyboard("{PageDown}");
    expect(cell("2026-11-29")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-29");
    expect(screen.getAllByRole("gridcell").filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it("will not pick before `min`", async () => {
    const onChange = vi.fn();
    render(<DatePicker inline min="2026-10-30" value={null} today={TODAY} label="Which day" onChange={onChange} />);
    expect(cell(TODAY)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Type a date" }), "今天{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-30");
  });

  it("names its parts for assistive technology", () => {
    render(<DatePicker inline value="2026-10-29" today={TODAY} label="Which day" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Which day" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    expect(cell("2026-10-29")).toHaveAttribute("aria-selected", "true");
  });
});

describe("DatePicker as a button", () => {
  it("opens a dialog at the button, picks, closes, and Esc closes", async () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-10-29" today={TODAY} label="Which day" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Which day" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Which day" });
    expect(dialog).not.toHaveClass("ui-menu--sheet");
    await userEvent.click(within(dialog).getByRole("button", { name: "Tomorrow" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-30");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a bottom sheet on a phone, with the keyboard kept down (focus on the grid)", async () => {
    setPhone(true);
    render(<DatePicker value="2026-10-29" today={TODAY} label="Which day" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Which day" }));
    expect(screen.getByRole("dialog", { name: "Which day" })).toHaveClass("ui-menu--sheet");
    expect(cell("2026-10-29")).toHaveFocus();
  });
});

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: "t1", title: "Write", status: "todo", source: "standalone", noteId: null, noteTitle: "",
  whenDate: null, evening: false, someday: false, deadline: null, recur: null, recurMode: "fixed", remindAt: null, hasBody: false, ...over,
} as TaskItem);
const noActions = (change: (t: TaskItem, c: unknown) => void) => ({ change, complete() {}, openNote() {}, openBody() {}, remove() {}, drop() {} });

describe("the places that used a native date input save the same values", () => {
  it("TaskSheet: a picked day becomes when_date, a deadline day becomes deadline", async () => {
    const change = vi.fn();
    render(<TaskSheet task={task()} today={TODAY} notes={[]} actions={noActions(change)} onClose={() => {}} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Pick a date…" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await userEvent.click(cell("2026-11-12"));
    expect(change).toHaveBeenLastCalledWith(expect.anything(), { when_date: "2026-11-12", evening: false, someday: false });
  });

  it("TaskSheet: a deadline day and a reminder (day + clock) are saved as YYYY-MM-DD and YYYY-MM-DDTHH:MM", async () => {
    const change = vi.fn();
    render(<TaskSheet task={task({ whenDate: "2026-11-02" })} today={TODAY} notes={[]} actions={noActions(change)} onClose={() => {}} />);
    const deadline = screen.getByRole("group", { name: "Deadline" });
    await userEvent.click(within(deadline).getAllByRole("button")[0]!); // the row opens its choices
    await userEvent.click(within(deadline).getByRole("button", { name: "Pick a date…" }));
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await userEvent.click(cell("2026-11-20"));
    expect(change).toHaveBeenLastCalledWith(expect.anything(), { deadline: "2026-11-20" });

    const reminder = screen.getByRole("group", { name: "Reminder" });
    await userEvent.click(within(reminder).getAllByRole("button")[0]!);
    await userEvent.click(within(reminder).getByRole("button", { name: "Pick a time…" }));
    expect(screen.getAllByRole("group", { name: "Reminder day" })).toHaveLength(1);
    await userEvent.click(cell("2026-10-30"));
    expect(change).toHaveBeenLastCalledWith(expect.anything(), { remind_at: "2026-10-30T09:00" });
  });

  it("TaskSheet: an existing reminder keeps its clock when the day changes, and its day when the clock changes", async () => {
    const change = vi.fn();
    render(<TaskSheet task={task({ whenDate: "2026-11-02", remindAt: "2026-11-02T14:30" })} today={TODAY} notes={[]} actions={noActions(change)} onClose={() => {}} />);
    const reminder = screen.getByRole("group", { name: "Reminder" });
    await userEvent.click(within(reminder).getAllByRole("button")[0]!); // the row, showing what is set
    await userEvent.click(within(reminder).getAllByRole("button", { name: /14:30$/ })[1]!);
    await userEvent.click(cell("2026-11-03"));
    expect(change).toHaveBeenLastCalledWith(expect.anything(), { remind_at: "2026-11-03T14:30" });
    // The clock is 24-hour hour and minute choices, and a change keeps the day.
    const clock = screen.getByRole("group", { name: "Reminder clock time" });
    expect(within(clock).getByLabelText("Hour")).toHaveValue("14");
    expect(within(clock).getByLabelText("Minute")).toHaveValue("30");
    await userEvent.selectOptions(within(clock).getByLabelText("Hour"), "21");
    expect(change).toHaveBeenLastCalledWith(expect.anything(), { remind_at: "2026-11-02T21:30" });
  });

  it("TaskSheet: a reminder never shows its raw stamp (T, Z, seconds), an instant is read in the workspace's clock", () => {
    render(<TaskSheet task={task({ whenDate: "2026-11-02", remindAt: "2026-11-15T09:00:00.000Z" })} today={TODAY} notes={[]} actions={noActions(vi.fn())} onClose={() => {}} />);
    const reminder = screen.getByRole("group", { name: "Reminder" });
    expect(reminder.textContent).not.toMatch(/\dT\d|Z\b|:00\.000/);
    expect(reminder.textContent).toMatch(/\d{2}:\d{2}/);
  });

  it("attribute date field: saves YYYY-MM-DD, and '' when cleared", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const field = { name: "Due", type: "date" } as never;
    render(<SchemaRow field={field} value="2026-11-01" onSave={onSave} allNodes={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Due" }));
    await userEvent.click(screen.getByRole("button", { name: "Pick a date…" }));
    await userEvent.click(cell("2026-11-17"));
    expect(onSave).toHaveBeenLastCalledWith("2026-11-17");
    await userEvent.click(screen.getByRole("button", { name: "Due" }));
    await userEvent.click(screen.getByRole("button", { name: "Pick a date…" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onSave).toHaveBeenLastCalledWith("");
  });
});
