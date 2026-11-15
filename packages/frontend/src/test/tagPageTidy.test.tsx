import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import MemberList from "../components/MemberList";
import { api, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { clearPhoneLayout, setPhoneLayout } from "./phoneMedia";

// The tag page tidied for the phone: the breadcrumb only with parents, a quiet
// save state, empty items left out, no 加功能 / 編輯結構, and a
// member list without empty columns or sideways scrolling.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));

const parent: Tag = { id: "t-parent", name: "media", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const book: Tag = { id: "t-book", name: "書籍", color: "", schema_id: "s-book", schema_extends: [], effective_modules: [],
  schema_fields: [{ name: "Author", type: "text" }, { name: "ISBN", type: "text" }] };
const child: Tag = { ...book, id: "t-child", name: "novel", parent_id: parent.id };
const note = (id: string, attrs: Record<string, string> = {}): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", class_tag_ids: [book.id], attrs });

beforeEach(() => {
  resetAppState();
  vi.mocked(api).mockReset().mockImplementation(async (path) => {
    if (path === "/api/tags") return [{ id: book.id, schema_fields: book.schema_fields, schema_behaviour: {} }] as never;
    if (path.endsWith("/delete-preview")) return { fields: [] } as never;
    return {} as never;
  });
});
afterEach(() => { cleanup(); clearPhoneLayout(); });

describe("tag page header", () => {
  it("has no breadcrumb without a parent tag, and one with it", () => {
    const { unmount } = render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[]} />);
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    unmount();
    render(<SchemaLens tag={child} online canManage allTags={[parent, child]} nodes={[]} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("All tags › media › novel");
  });

  it("shows no saving label while saved", () => {
    render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[]} />);
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves empty items out for a member: no parent line, no functions row, no note count", () => {
    render(<SchemaLens tag={book} online allTags={[book]} nodes={[note("a"), note("b")]} />);
    expect(screen.queryByRole("group", { name: "Functions" })).toBeNull();
    expect(screen.queryByText("Parent", { exact: false })).toBeNull();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByText("2 notes")).toBeNull();
  });
});

describe("the title row and the ⋯ menu by layout", () => {
  it("on the phone and on a wide screen alike, the title row has no 加功能 and no 編輯結構, but keeps pin and ⋯", () => {
    for (const phone of [true, false]) {
      setPhoneLayout(phone);
      render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[]} />);
      const row = screen.getByRole("heading", { level: 1 }).parentElement!;
      expect(within(row).queryByRole("button", { name: "Add function" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit structure" })).toBeNull();
      expect(within(row).getByRole("button", { name: "Pin tag" })).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Tag actions" })).toBeInTheDocument();
      // Fields keep their own entry.
      expect(screen.getByRole("button", { name: /Add field/ })).toBeInTheDocument();
      cleanup();
    }
  });

  it("the ⋯ menu carries move, merge, hide and delete — and nothing to open a structure panel", () => {
    render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(["Move under another tag…", "Merge into…", "Hide tag", "Delete tag"]));
    expect(screen.queryByRole("menuitem", { name: /Edit structure|Add function/ })).toBeNull();
  });

  it("on the phone a member has none of it", () => {
    setPhoneLayout(true);
    render(<SchemaLens tag={book} online allTags={[book]} nodes={[]} />);
    expect(screen.queryByRole("button", { name: "Add function" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tag actions" }));
    expect(screen.queryByRole("menuitem", { name: /Add function|Edit structure|Move under/ })).toBeNull();
  });
});

describe("member list", () => {
  const fields = [{ name: "Author", type: "text" }, { name: "ISBN", type: "text" }, { name: "Rating", type: "text" }] as never;
  const nodes = [note("a", { Author: "Herbert", ISBN: "978-1" }), note("b", { Author: "Le Guin" })];

  it("hides a field column nobody has a value for (wide screen)", () => {
    setPhoneLayout(false);
    render(<MemberList nodes={nodes} fields={fields} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Title", "Author", "ISBN"]);
  });

  it("without any value shows a plain list of titles", () => {
    render(<MemberList nodes={[note("a"), note("b")]} fields={fields} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("wide titles-only rows show the date and the body's first line, not the title or tags", () => {
    setPhoneLayout(false);
    const dated: ContentNode = { ...note("Dune"), updated_at: "2026-10-05T04:00:00Z", markdown: "---\ntitle: x\n---\n# Dune\n\n#書籍 Spice and **sand**.\nSecond line" };
    render(<MemberList nodes={[dated]} fields={[]} />);
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent(/Dune.*Spice and sand\./);
    expect(row).not.toHaveTextContent("書籍");
    expect(row).not.toHaveTextContent("title: x");
    expect(row.querySelector(".tag-member-values")!.textContent).toMatch(/^\S.* · Spice/);
  });

  it("wide rows without a body show only the date; without either, no meta line", () => {
    setPhoneLayout(false);
    render(<MemberList nodes={[{ ...note("a"), updated_at: "2026-10-05T04:00:00Z" }, note("b")]} fields={[]} />);
    const rows = screen.getAllByRole("listitem");
    const meta = rows[0].querySelector(".tag-member-values")!;
    expect(meta.textContent).not.toContain("·");
    expect(meta.textContent).not.toBe("");
    expect(rows[1].querySelector(".tag-member-values")).toBeNull();
  });

  it("flat rows and table rows get no date line", () => {
    setPhoneLayout(false);
    const dated = { ...note("a", { Author: "x" }), updated_at: "2026-10-05T04:00:00Z", markdown: "body" };
    const { unmount } = render(<MemberList nodes={[dated]} fields={fields} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(document.querySelector(".tag-member-values")).toBeNull();
    unmount();
    render(<MemberList nodes={[dated]} fields={[]} flat />);
    expect(document.querySelector(".tag-member-values")).toBeNull();
  });

  it("on the phone is rows: title, then the values it has; no table", () => {
    setPhoneLayout(true);
    render(<MemberList nodes={nodes} fields={fields} />);
    expect(screen.queryByRole("table")).toBeNull();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("aHerbert · 978-1");
    expect(rows[1]).toHaveTextContent("bLe Guin");
    expect(within(rows[1]).queryByText("·")).toBeNull();
  });
});
