import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { apiFetch, type ContentNode } from "../lib/api";

// A member who may only read a note must get both drawing surfaces read-only:
// the same canEdit the text editor uses, not just the drawing's own format.

const access = vi.hoisted(() => ({ mayEdit: false }));
vi.mock("../lib/capabilities", async (original) => ({ ...await original<typeof import("../lib/capabilities")>(), useCapabilities: () => ({ canEdit: () => access.mayEdit }) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));
const seen = vi.hoisted(() => ({ pdf: null as { readOnly?: boolean; readOnlyNotice?: string } | null, ink: null as { readOnly?: boolean; readOnlyNotice?: string } | null }));
vi.mock("../components/PdfNodeView", () => ({
  default: (props: { readOnly?: boolean; readOnlyNotice?: string }) => { seen.pdf = props; return <div>pdf surface</div>; },
}));
vi.mock("../components/InkNodeView", () => ({
  default: (props: { readOnly?: boolean; readOnlyNotice?: string }) => { seen.ink = props; return <div>handwriting surface</div>; },
}));

const node: ContentNode = { id: "n1", title: "Paper", slug: "paper", markdown: "", node_type: "content", source_type: "manual" };
const page = { version: 1, strokes: [{ id: "s1", points: [[0, 0]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } };

function editor(attrs: Array<{ key: string; value: string }>) {
  vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${node.id}/attributes?`) ? attrs : []), { status: 200 }));
  return render(<OverviewEditor node={node} titleDraft="Paper" onTitleChange={() => {}} draft="" onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[node]}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />);
}

afterEach(() => { seen.pdf = null; seen.ink = null; access.mayEdit = false; });

describe("drawing surfaces follow the note's edit permission", () => {
  it("a view-only PDF opens read-only, with the permission notice", { timeout: 20_000 }, async () => {
    editor([{ key: "pdf_url", value: "https://example.com/a.pdf" }, { key: "ink_data", value: JSON.stringify({ version: 1, pages: { 1: page }, annotations: [] }) }]);
    await screen.findByText("pdf surface", {}, { timeout: 10_000 });
    expect(seen.pdf?.readOnly).toBe(true);
    expect(seen.pdf?.readOnlyNotice).toMatch(/not change it/);
  });

  it("a view-only handwriting note opens read-only, with the permission notice", { timeout: 20_000 }, async () => {
    editor([{ key: "ink_data", value: JSON.stringify(page) }]);
    await screen.findByText("handwriting surface", {}, { timeout: 10_000 });
    expect(seen.ink?.readOnly).toBe(true);
    expect(seen.ink?.readOnlyNotice).toMatch(/not change it/);
  });

  it("a member who can edit still gets both surfaces writable", { timeout: 20_000 }, async () => {
    access.mayEdit = true;
    const view = editor([{ key: "ink_data", value: JSON.stringify(page) }]);
    await screen.findByText("handwriting surface", {}, { timeout: 10_000 });
    expect(seen.ink?.readOnly).toBe(false);
    view.unmount();
    editor([{ key: "pdf_url", value: "https://example.com/a.pdf" }]);
    await screen.findByText("pdf surface", {}, { timeout: 10_000 });
    expect(seen.pdf?.readOnly).toBe(false);
  });
});
