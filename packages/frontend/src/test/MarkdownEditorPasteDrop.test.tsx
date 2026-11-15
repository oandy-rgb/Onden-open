import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";

// Scan 01 #2, #6, #9: what a paste or a drop into the note editor does with files.

const shot = () => new File([new Uint8Array([1])], "image.png", { type: "image/png" });
const clipboard = (files: File[], text: string) => ({
  items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  files,
  getData: (type: string) => (type === "text/plain" ? text : ""),
});

function setup(opts: { readOnly?: boolean } = {}) {
  const onMediaInsert = vi.fn(async (f: File) => `\n![${f.name}](/m/${f.name})\n`);
  const onUnsupportedDrop = vi.fn();
  const { container } = render(
    <MarkdownEditor value="hello" onChange={vi.fn()} nodes={[]} onMediaInsert={onMediaInsert} onUnsupportedDrop={onUnsupportedDrop} readOnly={opts.readOnly} />,
  );
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  return { view, onMediaInsert, onUnsupportedDrop };
}
const dropOf = (files: File[]) => ({ dataTransfer: { files, types: ["Files"] }, clientX: 0, clientY: 0 });

describe("paste into the note editor", () => {
  it("a clipboard with text and a preview picture (Excel, Word) pastes the text, uploads nothing", () => {
    const { view, onMediaInsert } = setup();
    fireEvent.paste(view.contentDOM, { clipboardData: clipboard([shot()], "a\tb") });
    expect(onMediaInsert).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toContain("a\tb");
  });

  it("a lone picture uploads, and every picture of several does", async () => {
    const { view, onMediaInsert } = setup();
    fireEvent.paste(view.contentDOM, { clipboardData: clipboard([shot(), shot()], "") });
    await waitFor(() => expect(onMediaInsert).toHaveBeenCalledTimes(2));
  });

  it("a read-only note takes no picture and no wrapped link from a paste", () => {
    const { view, onMediaInsert } = setup({ readOnly: true });
    fireEvent.paste(view.contentDOM, { clipboardData: clipboard([shot()], "") });
    expect(onMediaInsert).not.toHaveBeenCalled();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    fireEvent.paste(view.contentDOM, { clipboardData: clipboard([], "https://example.com") });
    expect(view.state.doc.toString()).toBe("hello");
  });
});

describe("drop onto the note editor", () => {
  it("audio and video are inserted like pictures; a PDF is handed to the host", async () => {
    const { view, onMediaInsert, onUnsupportedDrop } = setup();
    const mp3 = new File(["x"], "song.mp3", { type: "audio/mpeg" });
    const pdf = new File(["x"], "paper.pdf", { type: "application/pdf" });
    fireEvent.drop(view.contentDOM, dropOf([mp3, pdf]));
    await waitFor(() => expect(onMediaInsert).toHaveBeenCalledWith(mp3));
    expect(onUnsupportedDrop).toHaveBeenCalledWith([pdf]);
  });

  it("a read-only note takes nothing from a drop but still keeps the browser from opening the file", () => {
    const { view, onMediaInsert, onUnsupportedDrop } = setup({ readOnly: true });
    const notPrevented = fireEvent.drop(view.contentDOM, dropOf([shot()]));
    expect(notPrevented).toBe(false); // default prevented
    expect(onMediaInsert).not.toHaveBeenCalled();
    expect(onUnsupportedDrop).not.toHaveBeenCalled();
  });

  it("a file dragged over the editor is not left to the browser's navigate-away default", () => {
    const { view } = setup({ readOnly: true });
    const notPrevented = fireEvent.dragOver(view.contentDOM, { dataTransfer: { types: ["Files"], files: [] } });
    expect(notPrevented).toBe(false);
  });
});
