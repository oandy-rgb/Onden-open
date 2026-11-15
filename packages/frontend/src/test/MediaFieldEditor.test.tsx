// GAP-133: the media field saved on every keystroke and was refilled from each
// save, storing fragments. It now saves the typed URL once (blur / Enter).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MediaFieldEditor } from "../components/attributes/MediaFieldEditor";

describe("MediaFieldEditor", () => {
  it("saves the whole typed URL once, on blur", () => {
    const onSave = vi.fn(async () => {});
    render(<MediaFieldEditor value="" onSave={onSave} />);
    const input = screen.getByPlaceholderText(/URL or upload/);
    for (const ch of "https://x.io/a.png") fireEvent.change(input, { target: { value: ((input as HTMLInputElement).value + ch) } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledExactlyOnceWith("https://x.io/a.png");
  });

  it("Enter saves; an unchanged value does not", () => {
    const onSave = vi.fn(async () => {});
    render(<MediaFieldEditor value="https://a" onSave={onSave} />);
    const input = screen.getByPlaceholderText(/URL or upload/);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "https://b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledExactlyOnceWith("https://b");
  });
});
