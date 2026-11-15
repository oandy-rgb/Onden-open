import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";

describe("one Enter, one line in the rendering", () => {
  it("renders newlines inside a paragraph as line breaks", () => {
    const { container } = render(<MarkdownRenderer>{"第一行\n第二行\n第三行"}</MarkdownRenderer>);
    expect(container.querySelectorAll("p br")).toHaveLength(2);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("leaves code blocks and blank-line paragraphs alone", () => {
    const { container } = render(<MarkdownRenderer>{"段一\n\n段二\n\n```\na\nb\n```"}</MarkdownRenderer>);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelectorAll("br")).toHaveLength(0);
    expect(container.querySelector("pre code")?.textContent).toContain("a\nb");
  });

  it("keeps callouts working", () => {
    const { container } = render(<MarkdownRenderer>{"> [!note] 標題\n> 內容第一行\n> 內容第二行"}</MarkdownRenderer>);
    expect(container.textContent).toContain("標題");
    expect(container.textContent).not.toContain("[!note]");
  });
});
