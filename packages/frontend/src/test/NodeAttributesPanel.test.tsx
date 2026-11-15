import { setAppState } from "../lib/appStore";
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }), getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null), upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}) }));
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NodeAttributesPanel from "../components/NodeAttributesPanel";
import { noWorkspaceData, type Tag } from "../lib/api";

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];

function mockFetch(responder: (url: string, init?: RequestInit) => unknown) {
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = responder(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const bookTag: Tag = {
  id: "tag-book",
  name: "book",
  color: "#f59e0b",
  schema_id: "schema-book",
  schema_slug: "book",
 
  schema_fields: [
    { name: "status",   label: "Status",   type: "select",  options: ["wishlist", "reading", "done"] },
    { name: "rating",   label: "Rating",   type: "number" },
    { name: "started",  label: "Started",  type: "date" },
  ],
};

beforeEach(() => { calls = []; setAppState({ online: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("NodeAttributesPanel", () => {
  it("renders schema-driven fields for each applied class tag", async () => {
    mockFetch(() => [
      { key: "status",  value: "reading", value_type: "text",   is_inheritable: false, source: "explicit" },
      { key: "rating",  value: "5",       value_type: "number", is_inheritable: false, source: "explicit" },
    ]);
    render(<NodeAttributesPanel nodeId="node-1" classTags={[bookTag]} />);
    await waitFor(() => expect(screen.getByText(/^#book$/)).toBeInTheDocument());
    // Schema fields with labels appear
    expect(screen.getByText(/Status/)).toBeInTheDocument();
    expect(screen.getByText(/Rating/)).toBeInTheDocument();
    expect(screen.getByText(/^Started$/)).toBeInTheDocument();
    // Existing values rendered. After the widget upgrade, select and number
    // fields render inline (not as click-to-edit buttons), so the value
    // lives in DOM input/select rather than text content.
    expect(await screen.findByRole("button", { name: "reading", pressed: true })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("5")).toBeInTheDocument();
  });

  it("shows the fields a tag inherits (effective_fields), with a value from the note", async () => {
    mockFetch(() => [{ key: "finished", value: "2026-10-15", value_type: "date", is_inheritable: false, source: "explicit" }]);
    const novel: Tag = {
      id: "tag-novel", name: "novel", color: "", schema_id: "tag-novel",
      schema_fields: [{ name: "pages", label: "Pages", type: "number" }],
      effective_fields: [
        { name: "pages", label: "Pages", type: "number" },
        { name: "finished", label: "Finished", type: "date", inherited_from: "tag-book" },
      ],
    };
    render(<NodeAttributesPanel nodeId="node-2" classTags={[novel]} />);
    await waitFor(() => expect(screen.getByText(/^#novel$/)).toBeInTheDocument());
    expect(screen.getByText(/Pages/)).toBeInTheDocument();
    expect(screen.getByText(/Finished/)).toBeInTheDocument();
    // An inherited field's value is the tag's, not an old field: no card of old fields.
    expect(screen.queryByText("none yet")).toBeNull();
  });

  it("a stale in-flight load for the previous node doesn't overwrite the current node (M12)", async () => {
    let resolveA: (() => void) | null = null;
    let resolveB: (() => void) | null = null;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const attr = (v: string) => [{ key: "note", value: v, value_type: "text", is_inheritable: false, source: "explicit" }];
    global.fetch = vi.fn((url: string) => {
      const own = url.includes("/attributes") && !url.includes("inherited") && !url.includes("rollup");
      if (own && url.includes("/nodes/A/")) return new Promise<Response>((res) => { resolveA = () => res(json(attr("A-value"))); });
      if (own && url.includes("/nodes/B/")) return new Promise<Response>((res) => { resolveB = () => res(json(attr("B-value"))); });
      return Promise.resolve(json([])); // inherited / rollup / others → immediate empty
    }) as unknown as typeof fetch;

    const { rerender } = render(<NodeAttributesPanel nodeId="A" classTags={[]} />);
    // Switch to node B BEFORE node A's attributes resolve.
    rerender(<NodeAttributesPanel nodeId="B" classTags={[]} />);
    await waitFor(() => expect(resolveB).toBeTruthy());
    resolveB!();
    await waitFor(() => expect(screen.getByText("B-value")).toBeInTheDocument());

    // The stale node-A response now arrives — it must NOT replace B's panel.
    await waitFor(() => expect(resolveA).toBeTruthy());
    resolveA!();
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText("B-value")).toBeInTheDocument();
    expect(screen.queryByText("A-value")).not.toBeInTheDocument();
  });

  it("shows a field several tags define once, in the first card, with 'also used by'", async () => {
    mockFetch(() => [{ key: "status", value: "reading", value_type: "text", is_inheritable: false, source: "explicit" }]);
    const meeting: Tag = { id: "tag-meeting", name: "meeting", color: "#888", schema_id: "schema-meeting",
      schema_fields: [{ name: "status", label: "Status", type: "select", options: ["reading"] }, { name: "room", type: "text" }] };
    render(<NodeAttributesPanel nodeId="node-1" classTags={[bookTag, meeting]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "reading", pressed: true })).toBeInTheDocument());
    expect(screen.getAllByText(/Status/)).toHaveLength(1);
    expect(screen.getByText("also used by #meeting")).toBeInTheDocument();
    const meetingCard = screen.getByRole("region", { name: "#meeting" });
    expect(meetingCard).toHaveTextContent("room");
    expect(meetingCard).not.toHaveTextContent("Status");
  });

  it("read-only: values only — no add field, no remove, no inputs", async () => {
    mockFetch((url) => (url.includes("inherited") || url.includes("rollup") ? [] : [
      { key: "status", value: "reading", value_type: "text", is_inheritable: false, source: "explicit" },
      { key: "note", value: "side thought", value_type: "text", is_inheritable: false, source: "explicit" },
    ]));
    render(<NodeAttributesPanel nodeId="node-1" classTags={[bookTag]} readOnly />);
    await waitFor(() => expect(screen.getByText("side thought")).toBeInTheDocument());
    expect(screen.getByText("reading")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByPlaceholderText("name")).toBeNull();
    expect(screen.queryByTitle("Remove")).toBeNull();
    fireEvent.click(screen.getByText("side thought"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("has no free add row: no name/value inputs, no add button", async () => {
    mockFetch((url) => (url.includes("inherited") || url.includes("rollup") ? []
      : [{ key: "note", value: "side thought", value_type: "text", is_inheritable: false, source: "explicit" }]));
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} />);
    await screen.findByText("side thought");
    expect(screen.queryByPlaceholderText("name")).toBeNull();
    expect(screen.queryByPlaceholderText("value")).toBeNull();
    expect(screen.queryByTitle("Add field")).toBeNull();
  });

  it("an old property (no tag has a field for it) keeps an editable value: PUT on save", async () => {
    mockFetch((url, init) => (init?.method === "PUT"
      ? { key: "note", value: "edited", value_type: "text", is_inheritable: false, source: "explicit" }
      : url.includes("inherited") || url.includes("rollup") ? []
        : [{ key: "note", value: "side thought", value_type: "text", is_inheritable: false, source: "explicit" }]));
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} otherLabel="Old fields" />);
    expect(await screen.findByText("Old fields")).toBeInTheDocument();
    fireEvent.click(screen.getByText("side thought"));
    const input = screen.getByDisplayValue("side thought");
    fireEvent.change(input, { target: { value: "edited" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.find((c) => c.init?.method === "PUT")?.url).toContain("/attributes/note"));
  });

  it("offline, a custom row keeps its number type and \"shares to children\" flag when edited (scan 06 M5)", async () => {
    const localDb = await import("../lib/localDb");
    vi.mocked(localDb.getNodeAttributeRecord).mockResolvedValue({ key: "priority", value: "3", value_type: "number", is_inheritable: true, source: "ui" } as never);
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "PUT") return new Response(JSON.stringify({ key: "priority", value: "4", value_type: "number", is_inheritable: true, source: "ui" }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    setAppState({ data: { ...noWorkspaceData, nodes: [{ id: "node-1", title: "N", slug: "n", markdown: "", node_type: "content", source_type: "manual", attrs: { priority: "3" } }] } });
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} otherLabel="Old fields" />);
    fireEvent.click(await screen.findByText("3"));
    const input = screen.getByDisplayValue("3");
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === "PUT")!.init?.body));
    expect(body).toMatchObject({ value: "4", value_type: "number", is_inheritable: true });
    vi.mocked(localDb.getNodeAttributeRecord).mockResolvedValue(null);
    setAppState({ data: noWorkspaceData });
  });

  it("a refused save is reported by the notice only: the panel keeps no error line of its own (scan 06 S10)", async () => {
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "PUT") return new Response(JSON.stringify({ error: "field_invalid" }), { status: 422, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(String(url).includes("inherited") || String(url).includes("rollup") ? [] : [{ key: "note", value: "side thought", value_type: "text", is_inheritable: false, source: "ui" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const { container } = render(<NodeAttributesPanel nodeId="node-1" classTags={[]} otherLabel="Old fields" />);
    fireEvent.click(await screen.findByText("side thought"));
    const input = screen.getByDisplayValue("side thought");
    fireEvent.change(input, { target: { value: "edited" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector(".attr-panel-error")).toBeNull();
  });

  it("the card of old fields appears only when there is one", async () => {
    mockFetch(() => []);
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByText("Other properties")).toBeNull();
    expect(screen.queryByText("none yet")).toBeNull();
  });

  it("draws the host's action beside an old property", async () => {
    mockFetch((url) => (url.includes("inherited") || url.includes("rollup") ? []
      : [{ key: "note", value: "side thought", value_type: "text", is_inheritable: false, source: "explicit" }]));
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} renderLegacyAction={(attr) => <button>make {attr.key}</button>} />);
    expect(await screen.findByRole("button", { name: "make note" })).toBeInTheDocument();
  });

  it("labels computed values plainly without the Σ math symbol", async () => {
    mockFetch((url) => {
      if (url.includes("/rollup-attributes")) {
        return [{ key: "total", label: "Total pages", value: 42, description: "sum of pages" }];
      }
      return [];
    });
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} />);
    await waitFor(() => expect(screen.getByText("Calculated from items below")).toBeInTheDocument());
    // Header is plain; the cryptic "Computed" + Σ symbol are gone.
    expect(screen.queryByText(/^Computed$/)).not.toBeInTheDocument();
    expect(screen.getByText("Total pages")).toBeInTheDocument();
    expect(screen.queryByText(/Σ/)).not.toBeInTheDocument();
    // Computed value still rendered (logic unchanged).
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("labels inherited values as 'From parent' without the ↑ arrow", async () => {
    mockFetch((url) => {
      if (url.includes("/inherited-attributes")) {
        return [{ key: "owner", value: "Ada", source_node_title: "Project X", source_node_id: "n-parent" }];
      }
      return [];
    });
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} />);
    await waitFor(() => expect(screen.getByText("From parent")).toBeInTheDocument());
    expect(screen.queryByText(/^Inherited$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
    // Value + source still rendered (logic unchanged).
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText(/Project X/)).toBeInTheDocument();
  });

  it("custom-row advanced toggle offers sharing only — no field type (types are the tag page's)", async () => {
    mockFetch((url) => {
      // Only the node's own attributes carry the custom row; inherited/rollup
      // endpoints stay empty so "side thought" is unambiguous.
      if (url.includes("/inherited-attributes") || url.includes("/rollup-attributes")) return [];
      return [
        { key: "note", value: "side thought", value_type: "text", is_inheritable: false, source: "explicit" },
      ];
    });
    render(<NodeAttributesPanel nodeId="node-1" classTags={[]} />);
    await waitFor(() => expect(screen.getByText("side thought")).toBeInTheDocument());

    const user = userEvent.setup();
    // Enter edit mode on the custom value, then open the advanced panel.
    await user.click(screen.getByText("side thought"));
    await user.click(screen.getByTitle("Show sharing"));

    // Plain, no-abbreviation labels — no "inh", no "Show advanced".
    expect(screen.queryByLabelText("Field type")).toBeNull();
    expect(screen.getByText("Shares to children")).toBeInTheDocument();
    expect(screen.queryByText(/^inh$/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Show advanced/)).not.toBeInTheDocument();
  });

  // A note fills values only (user decision 2026-10-18): the structure of a
  // tag is set on its page.
  it("no structure controls: no ↗ promote buttons, no add-to-tag, no option editing", async () => {
    mockFetch((url) => url.includes("/inherited-attributes") || url.includes("/rollup-attributes") ? [] : [
      { key: "isbn", value: "978", value_type: "text", is_inheritable: false, source: "explicit" },
    ]);
    render(<NodeAttributesPanel nodeId="node-1" classTags={[bookTag]} canEditTags />);
    await waitFor(() => expect(screen.getByText("978")).toBeInTheDocument());
    expect(screen.queryByText(/↗/)).toBeNull();
    expect(screen.queryByRole("button", { name: /add to #/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /rename|field type|options/i })).toBeNull();
    // A note can't add a free-form property any more.
    expect(screen.queryByPlaceholderText("name")).toBeNull();
  });

  it("the owner adds a new select option inline: saved on the tag's fields, then picked", async () => {
    mockFetch((url) => url.includes("/attributes") && !url.includes("inherited") && !url.includes("rollup")
      ? [{ key: "status", value: "reading", value_type: "text", is_inheritable: false, source: "explicit" }] : url.includes("/schema") ? { ok: true } : []);
    const onTagsChanged = vi.fn();
    render(<NodeAttributesPanel nodeId="node-1" classTags={[bookTag]} canEditTags onTagsChanged={onTagsChanged} />);
    await screen.findByRole("button", { name: "reading", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "+ New option…" }));
    const input = screen.getByRole("textbox", { name: "New option for Status" });
    fireEvent.change(input, { target: { value: "abandoned" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/tags/tag-book/schema"))).toBe(true));
    const schemaCall = calls.find((c) => c.url.includes("/api/tags/tag-book/schema"))!;
    expect(schemaCall.init?.method).toBe("PATCH");
    const body = JSON.parse(String(schemaCall.init?.body)) as { fields: Array<{ name: string; options?: string[] }> };
    expect(body.fields.find((f) => f.name === "status")?.options).toEqual(["wishlist", "reading", "done", "abandoned"]);
    expect(body.fields).toHaveLength(3); // the other fields are kept
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalled());
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT" && c.url.includes("/attributes/status"))).toBe(true));
    expect(screen.getByRole("button", { name: "abandoned" })).toBeInTheDocument();
  });

  it("a non-owner picks existing options only", async () => {
    mockFetch((url) => url.includes("/attributes") && !url.includes("inherited") && !url.includes("rollup")
      ? [{ key: "status", value: "reading", value_type: "text", is_inheritable: false, source: "explicit" }] : []);
    render(<NodeAttributesPanel nodeId="node-1" classTags={[bookTag]} />);
    await screen.findByRole("button", { name: "reading", pressed: true });
    expect(screen.queryByRole("button", { name: "+ New option…" })).toBeNull();
    const chips = within(screen.getByRole("group", { name: "Status" })).getAllByRole("button");
    expect(chips.map((o) => o.textContent)).toEqual(["wishlist", "reading", "done"]);
  });

  it("does not list the editor's own ink_data as a field", async () => {
    mockFetch(() => [
      { key: "ink_data", value: JSON.stringify({ version: 1, strokes: [[1, 2, 3]] }), value_type: "text", is_inheritable: false, source: "explicit" },
      { key: "mood", value: "calm", value_type: "text", is_inheritable: false, source: "explicit" },
    ]);
    render(<NodeAttributesPanel nodeId="node-ink" classTags={[]} />);
    await waitFor(() => expect(screen.getByText("mood")).toBeInTheDocument());
    expect(screen.queryByText("ink_data")).toBeNull();
    expect(document.body.textContent).not.toMatch(/strokes/);
  });

  it("does not list the PDF itself (pdf_url) as an old field", async () => {
    mockFetch(() => [
      { key: "pdf_url", value: "data:application/pdf;base64,JVBERi0xLjQK", value_type: "text", is_inheritable: false, source: "explicit" },
      { key: "mood", value: "calm", value_type: "text", is_inheritable: false, source: "explicit" },
    ]);
    render(<NodeAttributesPanel nodeId="node-pdf" classTags={[]} />);
    await waitFor(() => expect(screen.getByText("mood")).toBeInTheDocument());
    expect(screen.queryByText("pdf_url")).toBeNull();
    expect(document.body.textContent).not.toMatch(/base64/);
  });
});
