// The info panel's Tags tab picked on a note with relations (or functions) but no tag says so, instead of a
// blank panel: the "nothing at all" message covers only a note with nothing in any tab (NodeInspector).
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => { cleanup(); act(() => setLocalePref("system")); });

describe("info panel Tags tab", () => {
  it("says the note has no tags when other tabs have something", async () => {
    const target = node("n1", "Target");
    const linked = node("n2", "Linked");
    const edges: NodeEdge[] = [{ id: "e1", source_node_id: "n2", target_node_id: "n1", edge_type: "knowledge_link", status: "active" }];
    resetAppState({ data: { ...noWorkspaceData, nodes: [target, linked], edges }, online: true });
    render(<NodeInspector node={target} onSelectNode={() => {}} onTagsChanged={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tags" }));
    const panel = screen.getByRole("tabpanel");
    // The panel loads first (a parent may share values down), then says so.
    await waitFor(() => expect(panel).toHaveTextContent("No tags yet"));
    expect(panel).not.toHaveTextContent("This note has no tags, features or connections yet.");
  });
});
