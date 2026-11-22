import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { resetAppState } from "../lib/appStore";

// D93: the same-name field rule is one rule (@onden/markdown fieldNameClashes,
// the server's too). On a tag page only the field another tag already has the
// NAME of is kept back, marked inline; every other edit saves. A shared label
// is no clash, and a clash already stored (legacy) never blocks later edits.
// Offline, so each save is the queued PATCH body.

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (typeof path === "string" && path.includes("/schema")) throw new TypeError("Failed to fetch");
      if (path === "/api/tags") return [];
      return {};
    }),
    fetchTagMergePreview: vi.fn(),
    mergeTag: vi.fn(),
  };
});
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => null),
}));

import SchemaLens from "../components/tagPage";
import { addPendingWrite } from "../lib/localDb";
import type { Tag } from "../lib/api";

const BOOK = "00000000-0000-4000-8000-0000000000b0";
const NOVEL = "00000000-0000-4000-8000-0000000000b1";
const book = (fields: Tag["schema_fields"]): Tag => ({ id: BOOK, name: "書", color: "", schema_id: BOOK, schema_fields: fields });
const novel = (fields: Tag["schema_fields"]): Tag => ({ id: NOVEL, name: "小說", color: "", schema_id: NOVEL, parent_id: BOOK, schema_fields: fields });

function savedFields(): Array<{ name: string }> | undefined {
  const calls = vi.mocked(addPendingWrite).mock.calls.filter((c) => typeof c[1] === "string" && c[1].includes(`/schema`));
  const last = calls.at(-1);
  return last ? (JSON.parse(String(last[2])) as { fields: Array<{ name: string }> }).fields : undefined;
}

async function open(tag: Tag, allTags: Tag[]) {
  render(<SchemaLens tag={tag} online={false} onSaved={vi.fn()} allTags={allTags} canManage />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
/** A field's chip under the title: type, then name. */
const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`${name}$`) });
/** The open field popover. */
const popover = () => screen.getByRole("dialog", { name: "Field settings" });
const newFieldForm = () => within(screen.getByRole("dialog", { name: "Add field" }));
/** Types a name into the 「新增欄位」 form and presses 「確定」. */
function confirmNewField(label: string) {
  fireEvent.change(newFieldForm().getByPlaceholderText(/Field name/), { target: { value: label } });
  fireEvent.click(newFieldForm().getByRole("button", { name: "OK" }));
}

async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(700); }); }

beforeEach(() => { resetAppState(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("tag page and same-name fields (D93)", () => {
  it("a field labelled like an inherited one (another name) is no clash: the new field saves", async () => {
    const parent = book([{ name: "author", label: "作者", type: "text" }]);
    const child = novel([{ name: "writer", label: "作者", type: "text" }]);
    await open(child, [parent, child]);
    fireEvent.click(screen.getByRole("button", { name: /Add field/i }));
    await settle();
    // Nothing exists until 「確定」: the form is open, the list and the save are untouched.
    expect(newFieldForm().getByPlaceholderText(/Field name/)).toHaveProperty("value", "");
    expect(newFieldForm().queryByRole("alert")).toBeNull();
    expect(savedFields()).toBeUndefined();
    confirmNewField("作者");
    await settle();
    expect(savedFields()?.map((f) => f.name)).toEqual(["writer", "作者"]);
  });

  it("a new field is saved once it is confirmed with a name", async () => {
    const child = novel([{ name: "writer", label: "作者", type: "text" }]);
    await open(child, [child]);
    fireEvent.click(screen.getByRole("button", { name: /Add field/i }));
    confirmNewField("Pages");
    await settle();
    expect(savedFields()?.map((f) => f.name)).toEqual(["writer", "pages"]);
  });

  it("a legacy same-name field stays saveable: editing another field saves the whole list", async () => {
    const parent = book([{ name: "pages", type: "number" }]);
    const child = novel([{ name: "pages", type: "text" }, { name: "plot", type: "text" }]);
    await open(child, [parent, child]);
    fireEvent.click(chip("plot"));
    expect(within(popover()).queryByRole("alert")).toBeNull();
    fireEvent.click(within(popover()).getByRole("checkbox")); // required
    await settle();
    expect(savedFields()).toEqual([{ name: "pages", type: "text" }, { name: "plot", type: "text", required: true }]);
  });

  // A new field's key is derived around the names others hold, so a clash comes
  // from a draft that is ahead of the catalog (another device declared the name
  // meanwhile): the open page has the field, the catalog's copy of the tag not yet.
  it("only the field named like an inherited one is held back, marked; the rest saves", async () => {
    const parent = book([{ name: "pages", label: "Pages", type: "number" }]);
    const child = novel([{ name: "plot", type: "text" }, { name: "pages", type: "text" }]);
    await open(child, [parent, novel([{ name: "plot", type: "text" }])]);
    fireEvent.click(chip("pages"));
    expect(within(popover()).getByRole("alert").textContent).toMatch(/#書 already gives the field "Pages"/);
    fireEvent.click(within(popover()).getByRole("button", { name: "OK" }));
    fireEvent.click(chip("plot"));
    fireEvent.click(within(popover()).getByRole("checkbox")); // required — saves, without the held-back field
    await settle();
    expect(savedFields()).toEqual([{ name: "plot", type: "text", required: true }]);
  });

  it("a field a tag below already declares is held back on the parent, naming that tag", async () => {
    const parent = book([{ name: "author", type: "text" }, { name: "pages", type: "text" }]);
    const child = novel([{ name: "pages", label: "Pages", type: "number" }]);
    await open(parent, [book([{ name: "author", type: "text" }]), child]);
    fireEvent.click(chip("pages"));
    expect(within(popover()).getByRole("alert").textContent).toMatch(/#小說 below already has the field "Pages"/);
    fireEvent.click(within(popover()).getByRole("button", { name: "OK" }));
    fireEvent.click(chip("author"));
    fireEvent.click(within(popover()).getByRole("checkbox")); // required — saves, without the held-back field
    await settle();
    expect(savedFields()).toEqual([{ name: "author", type: "text", required: true }]);
  });
});
