import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BacklinkSnippetView } from "../components/BacklinkSnippetView";
import { findBacklinkSnippet, findMentionSnippet } from "../lib/backlinks";
import type { ContentNode } from "../lib/api";

const node = (over: Partial<ContentNode>): ContentNode => ({
  id: "n", title: "T", slug: "t", markdown: "", node_type: "content", source_type: "manual", ...over,
});

// A backlink preview shows the words around the link, never the note's Markdown.
describe("BacklinkSnippetView", () => {
  const text = (snip: NonNullable<ReturnType<typeof findBacklinkSnippet>>) => render(<BacklinkSnippetView snippet={snip} />).container;

  it("drops heading hashes, {task}, ^ids, the task box and [[ ]]", () => {
    const md = "## 寫筆記\n筆記就是一頁 {task} ^ab12\n- [ ] 讀 [[My Note]] 的第一章 **重點** ^ffb6f7\n";
    const snip = findBacklinkSnippet(node({ markdown: md }), node({ title: "My Note", slug: "my-note" }))!;
    const box = text(snip);
    expect(box.textContent).toBe("寫筆記 筆記就是一頁 讀 My Note 的第一章 重點");
    expect(box.textContent).not.toMatch(/[#{}^[\]*]/);
    expect(box.querySelector("mark")?.textContent).toBe("My Note");
  });

  it("an unlinked mention reads the same way and marks the mention", () => {
    const md = "# 清單\n- [x] 完成 Kafka 筆記 {task}\n";
    const snip = findMentionSnippet(node({ markdown: md }), "Kafka")!;
    const box = render(<BacklinkSnippetView snippet={snip} />).container;
    expect(box.textContent).toBe("清單 完成 Kafka 筆記");
    expect(box.querySelector("mark")?.textContent).toBe("Kafka");
  });
});
