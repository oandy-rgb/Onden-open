// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import OverviewEditor from "../components/OverviewEditor";
import type { ContentNode } from "../lib/api";

// A viewer who cannot edit a note stays in its preview: clicking blank space
// or double-clicking text must not switch to an editor they cannot type in.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));
vi.mock("../lib/capabilities", async (original) => ({
  ...await original<typeof import("../lib/capabilities")>(),
  useCapabilities: () => ({ canEdit: () => false, canCreateIn: () => false, ready: true }),
}));

const note: ContentNode = { id: "n1", title: "Note", slug: "note", markdown: "hello", node_type: "content", source_type: "manual" };

function Harness() {
  const [view, setView] = useState<"edit" | "preview">("preview");
  return <>
    <output data-testid="view">{view}</output>
    <OverviewEditor node={note} titleDraft="Note" onTitleChange={() => {}} draft="hello" onDraftChange={() => {}}
      view={view} setView={setView} saveStatus="saved" onSave={() => {}} online nodes={[note]}
      onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />
  </>;
}

afterEach(cleanup);

describe("preview of a read-only note", () => {
  it("does not switch to editing", { timeout: 20_000 }, async () => {
    const { container, getByTestId } = render(<Harness />);
    const article = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("article.obsidian-preview");
      expect(el).not.toBeNull();
      return el!;
    }, { timeout: 10_000 });
    fireEvent.click(article);
    fireEvent.doubleClick(article.querySelector("p")!);
    expect(getByTestId("view").textContent).toBe("preview");
  });
});
