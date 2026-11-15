import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, waitFor } from "@testing-library/react";
import MarkdownEditor, { type MarkdownEditorHandle } from "../components/MarkdownEditor";

// editor-no-file-attach regression: the file-picker toolbar button reaches the
// editor through this imperative handle. It must run a picked file through the
// SAME onMediaInsert pipeline the paste/drop handlers use and splice the
// returned markdown into the document at the caret — the only camera-roll path
// on iOS, where paste/drag don't exist.

function makeFile(name = "photo.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("MarkdownEditor insertMediaFile handle", () => {
  it("uploads the picked file via onMediaInsert and inserts the returned markdown", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const onMediaInsert = vi.fn(async (f: File) => `\n![${f.name}](https://media/${f.name})\n`);

    render(
      <MarkdownEditor
        ref={ref}
        value="hello"
        onChange={onChange}
        nodes={[]}
        onMediaInsert={onMediaInsert}
      />,
    );

    expect(ref.current).toBeTruthy();
    const file = makeFile();
    await ref.current!.insertMediaFile(file);

    // The picked file went through the shared upload path…
    expect(onMediaInsert).toHaveBeenCalledTimes(1);
    expect(onMediaInsert).toHaveBeenCalledWith(file);

    // …and the returned snippet was spliced into the doc (onChange echoes the
    // CodeMirror update), so the markdown body now carries the image.
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)?.[0] as string | undefined;
      expect(last).toContain("![photo.png](https://media/photo.png)");
    });
  });

  it("inserts nothing when the upload returns null (offline / failure)", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const onMediaInsert = vi.fn(async () => null);

    render(
      <MarkdownEditor
        ref={ref}
        value="hello"
        onChange={onChange}
        nodes={[]}
        onMediaInsert={onMediaInsert}
      />,
    );

    await ref.current!.insertMediaFile(makeFile());
    expect(onMediaInsert).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// Scan finding #4: the editor is not remounted per note, so an upload that
// finished after a note switch was inserted at the NEXT note's caret and
// autosaved there. It now goes to the note it was started in.
describe("an image that finishes uploading after the note changed", () => {
  it("goes to the note it was started in, not into the open document", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const editLeftNote = vi.fn();
    let finishUpload!: (snippet: string) => void;
    const onMediaInsert = vi.fn(() => new Promise<string>((resolve) => { finishUpload = resolve; }));
    const editor = (nodeKey: string, value: string) => (
      <MarkdownEditor ref={ref} nodeKey={nodeKey} value={value} onChange={onChange} nodes={[]}
        onMediaInsert={onMediaInsert} editLeftNote={editLeftNote} />
    );
    const { rerender } = render(editor("note-a", "text of a"));
    const inserting = ref.current!.insertMediaFile(makeFile());
    rerender(editor("note-b", "text of b"));
    finishUpload("![photo.png](https://media/photo.png)");
    await inserting;

    expect(onChange.mock.calls.some(([text]) => String(text).includes("photo.png"))).toBe(false);
    expect(editLeftNote).toHaveBeenCalledTimes(1);
    const [nodeKey, edit] = editLeftNote.mock.calls[0]!;
    expect(nodeKey).toBe("note-a");
    expect(edit("text of a")).toBe("text of a\n\n![photo.png](https://media/photo.png)");
  });
});
