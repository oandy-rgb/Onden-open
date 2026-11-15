import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { INSERT_MEDIA_ACCEPT } from "../lib/mediaInsert";
import MarkdownEditor from "../components/MarkdownEditor";

// F7: the slash menu starts a handwriting page or a PDF under the
// note (the host creates it) and links it where `/` was typed.

// jsdom has no layout: CodeMirror's caret coordinates need these on Range.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function typeAtEnd(container: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: "input.type" });
}

describe("slash insert items", () => {
  it("a handwriting page is created by the host and linked in place of the slash", async () => {
    const onChange = vi.fn();
    const onInsertPage = vi.fn(async () => "Handwriting 2026-10-13 17:05");
    const { container } = render(
      <MarkdownEditor value="" onChange={onChange} nodes={[]} onMediaInsert={vi.fn(async () => null)} onInsertPage={onInsertPage} />,
    );
    typeAtEnd(container, "/hand");
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Handwriting page/ }));
    await waitFor(() => expect(onInsertPage).toHaveBeenCalledWith("ink", undefined));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe("[[Handwriting 2026-10-13 17:05]]"));
  });

  it("offers only the image item when the host cannot create pages", async () => {
    const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} nodes={[]} onMediaInsert={vi.fn(async () => null)} />);
    typeAtEnd(container, "/");
    expect(await screen.findByRole("button", { name: /Image, audio or video/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Handwriting page/ })).toBeNull();
  });

  it("the file item opens a picker for image, audio and video and inserts the uploaded snippet", async () => {
    const onChange = vi.fn();
    const onMediaInsert = vi.fn(async (f: File) => `\n![${f.name}](/api/media/x.mp3)\n`);
    const picked: string[] = [];
    const file = new File(["x"], "lecture.mp3", { type: "audio/mpeg" });
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      picked.push(this.accept);
      Object.defineProperty(this, "files", { value: [file] });
      this.dispatchEvent(new Event("change"));
    });
    try {
      const { container } = render(<MarkdownEditor value="" onChange={onChange} nodes={[]} onMediaInsert={onMediaInsert} />);
      typeAtEnd(container, "/audio");
      fireEvent.mouseDown(await screen.findByRole("button", { name: /Image, audio or video/ }));
      await waitFor(() => expect(onMediaInsert).toHaveBeenCalledWith(file));
      expect(picked[0]).toBe(INSERT_MEDIA_ACCEPT);
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("![lecture.mp3](/api/media/x.mp3)"));
    } finally { click.mockRestore(); }
  });
});
