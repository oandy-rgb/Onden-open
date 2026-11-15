import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SchemaLens from "../components/tagPage";
import { api, type ContentNode, type Tag } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
// Online decisions check the local write queue first (onlineWrite.ts); jsdom has no DB worker.
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []), upsertNode: vi.fn(async () => null) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

// A tag's description is its own body (the class_tag node's markdown): shown
// under the title, edited in place by the owner, read by everyone else.

const book: Tag = { id: "book", name: "Book", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const tagNode = (markdown: string): ContentNode => ({ id: book.id, title: "Book", slug: "book", markdown, source_type: "manual", node_type: "class_tag" });

beforeEach(() => {
  resetAppState();
  vi.mocked(api).mockReset().mockImplementation(async (path, init) => {
    if (path === "/api/tags") return [] as never;
    if (path === `/api/nodes/${book.id}` && init?.method === "PATCH") return { ...tagNode(JSON.parse(init.body as string).markdown) } as never;
    return { fields: [] } as never;
  });
});

describe("the tag's description", () => {
  it("the owner edits it in place; leaving the box saves it as the tag's body", async () => {
    const node = tagNode("All books.");
    const { data } = getAppState();
    setAppState({ online: true, data: { ...data, nodes: [node] } });
    const onSaved = vi.fn();
    render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[node]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit the description" }));
    const box = screen.getByRole("textbox", { name: "Description" });
    expect(box).toHaveValue("All books.");
    fireEvent.change(box, { target: { value: "All books, read or not." } });
    fireEvent.blur(box);
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, init]) => path === `/api/nodes/${book.id}`
      && JSON.parse(init!.body as string).markdown === "All books, read or not."
      && JSON.parse(init!.body as string).base_markdown === "All books.")).toBe(true));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("Escape puts it back without saving; an empty one invites the owner to add it", () => {
    const node = tagNode("");
    render(<SchemaLens tag={book} online canManage allTags={[book]} nodes={[node]} />);
    fireEvent.click(screen.getByRole("button", { name: "No description yet. Click to add one." }));
    const box = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(box, { target: { value: "draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull();
    expect(vi.mocked(api).mock.calls.some(([path]) => path === `/api/nodes/${book.id}`)).toBe(false);
  });

  it("others read it, and see nothing when it is empty", () => {
    const { unmount } = render(<SchemaLens tag={book} online allTags={[book]} nodes={[tagNode("All books.")]} />);
    expect(screen.getByText("All books.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit the description" })).toBeNull();
    unmount();
    render(<SchemaLens tag={book} online allTags={[book]} nodes={[tagNode("")]} />);
    expect(screen.queryByText(/No description yet/)).toBeNull();
  });
});
