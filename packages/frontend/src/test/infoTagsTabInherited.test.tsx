// A note with no tag and no property of its own still shows what its parent shares down ("From parent") in the
// info panel's Tags tab. The tab used to say "No tags yet" and never loaded the panel that draws it, so a value
// shared with 「套用到子項目」 was invisible on every note that carried nothing itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NodeInspector from "../components/NodeInspector";
import { noWorkspaceData, type ContentNode, type NodeEdge } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { loadNoteFunctionModules } from "./helpers/noteFunctionModules";

await loadNoteFunctionModules();

const node = (id: string, title: string): ContentNode => ({
  id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", updated_at: "2026-11-05T00:00:00Z",
});

function answer(inherited: unknown[]) {
  global.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/inherited-attributes") ? inherited : []), {
    status: 200, headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

// A link keeps the Relations tab worth having, so the Tags tab is picked by hand, as on a note with functions.
const edges: NodeEdge[] = [{ id: "e1", source_node_id: "other", target_node_id: "child", edge_type: "knowledge_link", status: "active" }];
beforeEach(() => { resetAppState({ data: { ...noWorkspaceData, nodes: [node("child", "Child"), node("other", "Other")], edges }, online: true }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); act(() => setLocalePref("system")); });

describe("info panel Tags tab on a note with nothing of its own", () => {
  it("shows the values its parent shares", async () => {
    answer([{ key: "owner", value: "Ada", source_node_title: "Project X", source_node_id: "parent" }]);
    render(<NodeInspector node={node("child", "Child")} onSelectNode={() => {}} onTagsChanged={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    await waitFor(() => expect(screen.getByText("From parent")).toBeInTheDocument());
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("still says 'No tags yet' when the parent shares nothing", async () => {
    answer([]);
    render(<NodeInspector node={node("child", "Child")} onSelectNode={() => {}} onTagsChanged={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveTextContent("No tags yet"));
  });
});
