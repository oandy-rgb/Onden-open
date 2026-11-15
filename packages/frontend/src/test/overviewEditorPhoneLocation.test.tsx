// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import type { ContentNode } from "../lib/api";

// The path above the title is the desktop's; on a phone it lives in the top bar
// (PhoneNoteLocation), so the title moves up.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));

const parent: ContentNode = { id: "p", title: "Meetings", slug: "p", markdown: "", node_type: "content", source_type: "manual" };
const note: ContentNode = { id: "n", title: "Weekly", slug: "n", markdown: "text", node_type: "content", source_type: "manual", parent_id: "p" };

const editor = () => (
  <OverviewEditor node={note} titleDraft={note.title} onTitleChange={() => {}} draft="text" onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[parent, note]}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />
);

function stubPhone(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    matches, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
}

afterEach(cleanup);

describe("note editor: the line above the title", () => {
  it("is drawn on a wide screen", () => {
    const restore = stubPhone(false);
    try {
      const { container } = render(editor());
      expect(container.querySelector(".note-breadcrumb")).not.toBeNull();
    } finally { restore(); }
  });

  it("is not drawn on a phone", () => {
    const restore = stubPhone(true);
    try {
      const { container } = render(editor());
      expect(container.querySelector(".note-breadcrumb")).toBeNull();
      expect(container.querySelector(".obsidian-title-input")).not.toBeNull();
    } finally { restore(); }
  });
});
