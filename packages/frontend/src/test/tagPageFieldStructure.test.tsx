import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SchemaLens, { promotableProperties } from "../components/tagPage";
import { api, type ContentNode, type Tag } from "../lib/api";
import { tagSchemaWriter } from "../lib/data/domainWriters";
import { resetAppState } from "../lib/appStore";
import { requestTagFields } from "../lib/tagPageRequest";

// A note fills values; a tag's structure lives on its page (user decision
// 2026-10-18). The tag page offers 「升級成欄位」 for properties its notes
// already use — the same field-list edit the note sidebar's 「↗ 加到」 made,
// saved by the tag-schema writer — as a line under the field chips, and a
// note's 「編輯 #X 的欄位 →」 opens the page with its field chips in focus.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/data/domainWriters", async (load) => {
  const actual = await load<typeof import("../lib/data/domainWriters")>();
  return { ...actual, tagSchemaWriter: { ...actual.tagSchemaWriter, update: vi.fn() } };
});

const book: Tag = { id: "t-book", name: "book", color: "", schema_id: "s-book", schema_extends: [], effective_modules: [],
  schema_fields: [{ name: "author", type: "text" }] };
const meeting: Tag = { id: "t-meeting", name: "meeting", color: "", schema_id: "s-meeting", schema_fields: [{ name: "room", type: "text" }] };
const note = (id: string, attrs: Record<string, string>, tagIds = [book.id]): ContentNode =>
  ({ id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", class_tag_ids: tagIds, attrs });
const nodes = [
  note("a", { pages: "412", isbn: "978-1", author: "Herbert", _system: "x" }),
  note("b", { pages: "180", room: "B1" }, [book.id, meeting.id]),
  note("c", { pages: "99" }, [meeting.id]), // not tagged #book
];

beforeEach(() => {
  resetAppState();
  vi.mocked(tagSchemaWriter.update).mockReset().mockResolvedValue({ status: "synced" } as never);
  vi.mocked(api).mockReset().mockImplementation(async (path) => {
    if (path === "/api/tags") return [{ id: book.id, schema_fields: book.schema_fields, schema_behaviour: {} }] as never;
    if (path.endsWith("/delete-preview")) return { fields: [] } as never;
    return {} as never;
  });
});

describe("tag page fields: 升級成欄位", () => {
  it("lists the plain properties of the tag's own notes, most used first", () => {
    const byId = new Map([book, meeting].map((tag) => [tag.id, tag]));
    expect(promotableProperties(nodes, book.id, book.schema_fields!, byId)).toEqual([
      { key: "pages", notes: 2, sample: "412" },
      { key: "isbn", notes: 1, sample: "978-1" },
    ]); // author is a field already, room is #meeting's field, _system is reserved
  });

  it("promotes with the tag-schema writer: the field is appended with an inferred type", async () => {
    render(<SchemaLens tag={book} online canManage allTags={[book, meeting]} nodes={nodes} />);
    const group = screen.getByRole("group", { name: "Make into a field" });
    expect(within(group).getByTitle("2 notes")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Make “pages” a field of #book" }));
    await waitFor(() => expect(tagSchemaWriter.update).toHaveBeenCalledWith(book.id, {
      fields: [{ name: "author", type: "text" }, { name: "pages", type: "number" }],
    }));
    expect(screen.queryByRole("button", { name: "Make “pages” a field of #book" })).toBeNull();
  });

  it("does not offer a property a tag above already gives as a field (tagFields, inheritedClash)", () => {
    const inheriting = { ...book, effective_fields: [...book.schema_fields!, { name: "pages", type: "number", inherited_from: "t-parent" }] } as Tag;
    render(<SchemaLens tag={inheriting} online canManage allTags={[inheriting, meeting]} nodes={nodes} />);
    const group = screen.getByRole("group", { name: "Make into a field" });
    expect(within(group).queryByText("pages")).toBeNull();
    expect(within(group).getByText("isbn")).toBeInTheDocument();
  });

  it("is the owner's: a non-owner sees no promote", () => {
    render(<SchemaLens tag={book} online allTags={[book, meeting]} nodes={nodes} />);
    expect(screen.queryByRole("button", { name: "Add field" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Make into a field" })).toBeNull();
  });

  it("「編輯 #X 的欄位 →」 opens the page with its fields row in focus; it is taken once, and a page already showing the tag hears it", () => {
    requestTagFields(book.id);
    const { unmount } = render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[]} />);
    const row = screen.getByRole("group", { name: "Fields" });
    expect(row.contains(document.activeElement)).toBe(true);
    unmount();
    // Taken once: opening the tag again starts with nothing in focus.
    render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[]} />);
    expect(screen.getByRole("group", { name: "Fields" }).contains(document.activeElement)).toBe(false);
    // A page already showing the tag hears the request.
    act(() => requestTagFields(book.id));
    expect(screen.getByRole("group", { name: "Fields" }).contains(document.activeElement)).toBe(true);
  });

  it("a non-owner's request focuses nothing: the structure is the owner's", () => {
    requestTagFields(book.id);
    render(<SchemaLens tag={book} online allTags={[book]} nodes={[]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
