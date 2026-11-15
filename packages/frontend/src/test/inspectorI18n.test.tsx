// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import NodeInspector from "../components/NodeInspector";
import { noWorkspaceData, type ContentNode, type NodeEdge } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import type { CanvasMembership } from "@onden/contract";
import { loadNoteFunctionModules } from "./helpers/noteFunctionModules";

// The inspector loads its 功能 and AI tabs on use; load them now, so a slow run (the full suite under load)
// does not finish a test while that load is still on its way and evaluate it after the environment is gone.
await loadNoteFunctionModules();
await import("../components/infoAi");

// Regression: the right-side Inspector's section headers + row labels must run
// through t(), so switching to zh-TW does not leave them stranded in English
// (a state-gallery screenshot review caught them rendering English under zh-TW).

const makeNode = (overrides: Partial<ContentNode> = {}): ContentNode => ({
  id: Math.random().toString(36).slice(2),
  title: "Test Note",
  slug: "test-note",
  markdown: "",
  node_type: "content",
  source_type: "manual",
  updated_at: "2026-06-02T00:00:00Z",
  ...overrides,
});

afterEach(() => {
  act(() => setLocalePref("system")); // jsdom navigator.language = en-US
});

function renderInspector() {
  const target = makeNode({ id: "n1", title: "Target" });
  const source = makeNode({ id: "n2", title: "Source" });
  const out = makeNode({ id: "n3", title: "Outgoing" });
  const edges: NodeEdge[] = [
    { id: "e1", source_node_id: "n2", target_node_id: "n1", edge_type: "knowledge_link", status: "active" },
    { id: "e2", source_node_id: "n1", target_node_id: "n3", edge_type: "knowledge_link", status: "active" },
  ];
  const canvas_memberships: CanvasMembership[] = [
    { canvas_id: "c1", canvas_title: "My Canvas", node_id: "n1" },
  ];
  resetAppState({
    data: { ...noWorkspaceData, nodes: [target, source, out], edges, canvas_memberships },
    online: true,
  });
  render(
    <NodeInspector
      node={target}
      onSelectNode={() => {}}
      onTagsChanged={() => {}}
    />,
  );
}

describe("NodeInspector labels are i18n-wired", () => {
  it("section headers + row labels translate under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    renderInspector();

    // Section header (the relationships moved under the note body and the
    // edited time into the note header: noteRelations / noteHeaderHistory
    // tests cover their labels).
    expect(screen.getByRole("tab", { name: "標籤" })).toBeTruthy(); // Tags
    expect(screen.getByRole("tab", { name: "功能" })).toBeTruthy(); // Functions

    // English originals must be gone for these chrome strings.
    expect(screen.queryByText("Functions")).toBeNull();
  });

  it("English locale keeps the literal labels (identity)", () => {
    act(() => setLocalePref("en"));
    renderInspector();
    expect(screen.getByRole("tab", { name: "Tags" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Functions" })).toBeTruthy();
  });

  it("empty-node placeholder translates under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    resetAppState({ data: { ...noWorkspaceData }, online: true });
    render(
      <NodeInspector
        node={null}
        onSelectNode={() => {}}
      />,
    );
    expect(screen.getByText("選一個筆記以查看細節")).toBeTruthy();
    expect(screen.queryByText("Select a node to see details")).toBeNull();
  });
});
