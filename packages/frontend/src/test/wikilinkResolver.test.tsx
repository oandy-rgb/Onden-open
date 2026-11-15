// Every wikilink resolver must treat `[[Page|alias]]` and `[[Page#heading]]`
// as links to Page; a second copy in lib/backlinks.ts did not.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { nodeMatchesLink as fromBacklinks } from "../lib/backlinks";
import { nodeMatchesLink as fromUtils } from "../lib/utils";
import type { ContentNode } from "../lib/api";

const page = { id: "p", title: "Process Scheduling", slug: "process-scheduling" } as ContentNode;

describe("wikilink resolution", () => {
  it.each([["alias", "Process Scheduling|scheduling"], ["heading", "Process Scheduling#Round robin"], ["plain", "process scheduling"]])(
    "resolves a %s link the same way everywhere", (_kind, label) => {
      expect(fromBacklinks(page, label)).toBe(true);
      expect(fromUtils(page, label)).toBe(true);
    },
  );

  it("the note renderer resolves a heading link to its page", () => {
    const { container } = render(
      <MarkdownRenderer nodes={[page]} onNavigate={() => {}}>{"See [[Process Scheduling#Round robin]]."}</MarkdownRenderer>,
    );
    expect(container.querySelector(".wikilink-token.known")).not.toBeNull();
  });

  // Logseq 2.0.2 cross-check: a link to a deleted/missing note stays visible as an unresolved link.
  // (By-id links to a deleted task: test/taskEmbed.test.tsx "a task the reader cannot read".)
  it("a link whose note is gone stays on screen as an unresolved link, not vanished", () => {
    const { container } = render(
      <MarkdownRenderer nodes={[page]} onNavigate={() => {}}>{"See [[Deleted Note]] here."}</MarkdownRenderer>,
    );
    const token = container.querySelector(".wikilink-token");
    expect(token?.textContent).toBe("Deleted Note");
    expect(token?.classList.contains("known")).toBe(false);
  });
});
