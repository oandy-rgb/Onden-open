import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReplaceWith } from "./ReplaceWith";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(cleanup);

const options = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta", hint: "The second." }, { id: "c", label: "Gamma" }];
function setup(mobile = false) {
  const calls = { preview: vi.fn(), apply: vi.fn(), close: vi.fn() };
  render(<ReplaceWith title="Change to…" applyLabel="Apply" options={options} current="a" mobile={mobile}
    onPreview={calls.preview} onApply={calls.apply} onClose={calls.close} />);
  return calls;
}

describe("ReplaceWith", () => {
  it("starts on what is in effect, with nothing to apply", () => {
    const { preview } = setup();
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("previews on a mouse resting on an option, on focus and on a tap, and keeps the last one shown", () => {
    const { preview, apply } = setup();
    fireEvent.mouseEnter(screen.getByRole("radio", { name: "Beta" }));
    expect(preview).toHaveBeenLastCalledWith("b");
    fireEvent.focus(screen.getByRole("radio", { name: "Gamma" }));
    expect(preview).toHaveBeenLastCalledWith("c");
    fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(preview).toHaveBeenLastCalledWith("b");
    expect(apply).not.toHaveBeenCalled(); // nothing is saved by looking
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(apply).toHaveBeenCalledWith("b");
  });

  it("walks the options with the arrow keys, and puts the content back when it closes", () => {
    const { preview, close } = setup();
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Beta" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalled();
    cleanup();
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("is a bottom sheet on a phone, with the same choices", () => {
    setup(true);
    expect(screen.getByRole("dialog", { name: "Change to…" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});

describe("ReplaceWith: Esc", () => {
  it("closes the panel beside the content, wherever focus is", () => {
    const { close } = setup(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is the sheet's own on a phone: the panel does not listen a second time", () => {
    const { close } = setup(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
