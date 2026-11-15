// Typing while the membership gate is up is kept and delivered to the field
// it was meant for once the gate lifts (cold-start gate, Step D).
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import GateTypingBuffer from "../components/GateTypingBuffer";

function Harness({ gated, onSubmit = () => {} }: { gated: boolean; onSubmit?: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <>
      <div className="membership-gate" data-testid="scrim" />
      <GateTypingBuffer active={gated} />
      <section className="workspace-grid">
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
          <input aria-label="quick add" value={value} onChange={(e) => setValue(e.target.value)} />
        </form>
        <p>not editable</p>
      </section>
    </>
  );
}

const buffer = () => document.querySelector(".gate-typing-buffer") as HTMLTextAreaElement;
const typeIntoBuffer = (text: string) => fireEvent.change(buffer(), { target: { value: buffer().value + text } });

afterEach(() => { vi.restoreAllMocks(); });

describe("GateTypingBuffer", () => {
  it("keeps typing for the field that had focus when the gate rose", () => {
    const view = render(<Harness gated={false} />);
    const input = screen.getByLabelText("quick add") as HTMLInputElement;
    input.focus();
    view.rerender(<Harness gated />);
    expect(document.activeElement).toBe(buffer());
    typeIntoBuffer("Call the dentist");
    view.rerender(<Harness gated={false} />);
    expect(input.value).toBe("Call the dentist");
    expect(document.activeElement).toBe(input);
  });

  it("a click on the scrim targets the field under it", () => {
    const view = render(<Harness gated />);
    const input = screen.getByLabelText("quick add") as HTMLInputElement;
    fireEvent.mouseDown(screen.getByTestId("scrim"), { clientX: 40, clientY: 20 });
    expect(document.activeElement).toBe(buffer());
    typeIntoBuffer("buy milk");
    document.elementFromPoint = vi.fn(() => input);
    view.rerender(<Harness gated={false} />);
    expect(document.elementFromPoint).toHaveBeenCalledWith(40, 20);
    expect(input.value).toBe("buy milk");
  });

  it("Enter in a one-line field submits its form after the text is in", async () => {
    const onSubmit = vi.fn();
    const view = render(<Harness gated={false} onSubmit={onSubmit} />);
    (screen.getByLabelText("quick add") as HTMLInputElement).focus();
    view.rerender(<Harness gated onSubmit={onSubmit} />);
    typeIntoBuffer("Water the plants");
    fireEvent.keyDown(buffer(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(<Harness gated={false} onSubmit={onSubmit} />);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Water the plants"));
  });

  it("drops typing that had no target", () => {
    const view = render(<Harness gated />);
    typeIntoBuffer("stray");
    view.rerender(<Harness gated={false} />);
    expect((screen.getByLabelText("quick add") as HTMLInputElement).value).toBe("");
    expect(buffer().value).toBe("");
  });

  it("a click that lands on nothing editable inserts nothing", () => {
    const view = render(<Harness gated />);
    fireEvent.mouseDown(screen.getByTestId("scrim"), { clientX: 5, clientY: 5 });
    typeIntoBuffer("lost");
    document.elementFromPoint = vi.fn(() => screen.getByText("not editable"));
    view.rerender(<Harness gated={false} />);
    expect((screen.getByLabelText("quick add") as HTMLInputElement).value).toBe("");
  });

  it("waits for an open IME composition before delivering", () => {
    const view = render(<Harness gated={false} />);
    const input = screen.getByLabelText("quick add") as HTMLInputElement;
    input.focus();
    view.rerender(<Harness gated />);
    fireEvent.compositionStart(buffer());
    typeIntoBuffer("打電話");
    view.rerender(<Harness gated={false} />);
    expect(input.value).toBe("");
    act(() => { fireEvent.compositionEnd(buffer()); });
    expect(input.value).toBe("打電話");
  });
});
