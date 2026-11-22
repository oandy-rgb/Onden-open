import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { resetAppState } from "../lib/appStore";

// Fields on the tag page are chips under the title. Pressing one opens its
// settings in a popover (name, type, required, default, delete); the chips drag
// to reorder; a table view's column name opens the same popover. Offline, so
// each save is the queued PATCH body.

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (typeof path === "string" && path.includes("/schema")) throw new TypeError("Failed to fetch");
      if (path === "/api/tags") return [];
      return {};
    }),
  };
});
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
}));
vi.mock("../components/confirmFieldRemoval", () => ({ confirmFieldRemoval: vi.fn(async () => true) }));

import SchemaLens from "../components/tagPage";
import TableLayout from "../modules/table/TableLayout";
import { addPendingWrite } from "../lib/localDb";
import { requestFieldEditor } from "../lib/tagFieldRequest";
import type { ExecResponse } from "../lib/viewExec";
import type { Tag } from "../lib/api";

const BOOK = "00000000-0000-4000-8000-0000000000b0";
const book = (fields: Tag["schema_fields"]): Tag => ({ id: BOOK, name: "書", color: "", schema_id: BOOK, schema_fields: fields });
const FIELDS: Tag["schema_fields"] = [
  { name: "author", label: "Author", type: "text" },
  { name: "rating", label: "Rating", type: "number" },
];

function savedFields(): Array<Record<string, unknown>> | undefined {
  const calls = vi.mocked(addPendingWrite).mock.calls.filter((c) => typeof c[1] === "string" && c[1].includes("/schema"));
  const last = calls.at(-1);
  return last ? (JSON.parse(String(last[2])) as { fields: Array<Record<string, unknown>> }).fields : undefined;
}
const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`${name}$`) });
const popover = () => screen.getByRole("dialog", { name: "Field settings" });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });
async function open(tag: Tag, canManage = true) {
  render(<SchemaLens tag={tag} online={false} onSaved={vi.fn()} allTags={[tag]} canManage={canManage} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => { resetAppState(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("field chips and the field popover", () => {
  it("shows a chip per field with its type and name, and no 編輯結構 button", async () => {
    await open(book(FIELDS));
    const row = screen.getByRole("group", { name: "Fields" });
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["textAuthor", "numberRating", "Add field"]);
    expect(screen.queryByRole("button", { name: "Edit structure" })).toBeNull();
  });

  it("renames a field, changes its type, marks it required, sets a default — each saved", async () => {
    await open(book(FIELDS));
    fireEvent.click(chip("Author"));
    const dialog = popover();
    fireEvent.change(within(dialog).getByPlaceholderText(/Field name/), { target: { value: "Writer" } });
    await settle();
    expect(savedFields()?.[0]).toMatchObject({ name: "author", label: "Writer" });
    fireEvent.change(within(dialog).getAllByRole("combobox")[0]!, { target: { value: "date" } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    await settle();
    expect(savedFields()?.[0]).toMatchObject({ type: "date", required: true });
    fireEvent.change(within(dialog).getByPlaceholderText("(none)"), { target: { value: "2026-01-02" } });
    await settle();
    expect(savedFields()?.[0]).toMatchObject({ default: "2026-01-02" });
    expect(chip("Writer")).toBeInTheDocument();
  });

  it("deletes a field after the usual check, and the popover closes", async () => {
    await open(book(FIELDS));
    fireEvent.click(chip("Rating"));
    await act(async () => { fireEvent.click(within(popover()).getByRole("button", { name: "Delete field" })); await vi.advanceTimersByTimeAsync(0); });
    await settle();
    expect(savedFields()?.map((f) => f.name)).toEqual(["author"]);
    expect(screen.queryByRole("dialog", { name: "Field settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rating$/ })).toBeNull();
  });

  it("drag a chip onto another to reorder; Alt + arrow does the same from the keyboard", async () => {
    await open(book(FIELDS));
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(chip("Rating"), { dataTransfer });
    fireEvent.dragOver(chip("Author"), { dataTransfer });
    fireEvent.drop(chip("Author"), { dataTransfer });
    await settle();
    expect(savedFields()?.map((f) => f.name)).toEqual(["rating", "author"]);
    fireEvent.keyDown(chip("Rating"), { key: "ArrowRight", altKey: true });
    await settle();
    expect(savedFields()?.map((f) => f.name)).toEqual(["author", "rating"]);
  });

  it("a table view's column name opens the same popover on that field", async () => {
    await open(book(FIELDS));
    const exec = {
      view: { visible_fields: ["title", "rating"], field_meta: {}, layout_config: {} }, rows: [{ id: "n1", title: "A", slug: "a", updated_at: "2026-01-01T00:00:00Z", attributes: { rating: "4" } }],
    } as unknown as ExecResponse;
    render(<TableLayout exec={exec} editFieldsOf={BOOK} />);
    // The built-in title column is not a field; the schema column is.
    expect(screen.queryByRole("button", { name: "Title" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "rating" }));
    expect(within(popover()).getByPlaceholderText(/Field name/)).toHaveProperty("value", "Rating");
  });

  describe("新增欄位", () => {
    const form = () => within(screen.getByRole("dialog", { name: "Add field" }));
    const nameBox = () => form().getByPlaceholderText(/Field name/);

    it("opens on the name box, and nothing exists yet: no chip, no save", async () => {
      await open(book(FIELDS));
      fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
      expect(nameBox()).toHaveFocus();
      expect(screen.queryByRole("button", { name: /New field/ })).toBeNull();
      await settle();
      expect(savedFields()).toBeUndefined();
    });

    it("on a touch screen the name box still has the cursor: this form exists to be filled in", async () => {
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList);
      await open(book(FIELDS));
      fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
      expect(nameBox()).toHaveFocus();
    });

    it("closing it any way but 「確定」 leaves nothing behind", async () => {
      await open(book(FIELDS));
      fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
      fireEvent.change(nameBox(), { target: { value: "Pages" } });
      fireEvent.click(form().getByRole("button", { name: "Cancel" }));
      await settle();
      expect(screen.queryByRole("dialog", { name: "Add field" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Pages$/ })).toBeNull();
      expect(savedFields()).toBeUndefined();
      fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
      fireEvent.keyDown(nameBox(), { key: "Escape" });
      await settle();
      expect(screen.queryByRole("dialog", { name: "Add field" })).toBeNull();
      expect(within(screen.getByRole("group", { name: "Fields" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["textAuthor", "numberRating", "Add field"]);
    });

    it("「確定」 stays off until there is a name; Enter on an empty name does nothing and does not close", async () => {
      await open(book(FIELDS));
      fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
      expect(form().getByRole("button", { name: "OK" })).toBeDisabled();
      fireEvent.keyDown(nameBox(), { key: "Enter" });
      fireEvent.change(nameBox(), { target: { value: "   " } });
      fireEvent.keyDown(nameBox(), { key: "Enter" });
      await settle();
      expect(screen.getByRole("dialog", { name: "Add field" })).toBeInTheDocument();
      expect(savedFields()).toBeUndefined();
    });

    it("a name and a kind, then Enter: the field is made with that kind and saved", async () => {
      await open(book(FIELDS));
      fireEvent.click(screen.getByRole("button", { name: /Add field/ }));
      fireEvent.change(form().getByRole("combobox"), { target: { value: "date" } });
      fireEvent.change(nameBox(), { target: { value: "Due date" } });
      fireEvent.keyDown(nameBox(), { key: "Enter" });
      await settle();
      expect(screen.queryByRole("dialog", { name: "Add field" })).toBeNull();
      expect(savedFields()?.at(-1)).toMatchObject({ name: "due_date", label: "Due date", type: "date" });
      expect(chip("Due date")).toBeInTheDocument();
    });
  });

  it("a member sees the chips but cannot open, drag or add", async () => {
    await open(book(FIELDS), false);
    expect(screen.queryByRole("button", { name: /Author$/ })).toBeNull();
    expect(screen.getByText("Author")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add field/ })).toBeNull();
    requestFieldEditor({ tagId: BOOK, field: 0, at: { x: 0, y: 0 } });
    expect(screen.queryByRole("dialog", { name: "Field settings" })).toBeNull();
  });
});
