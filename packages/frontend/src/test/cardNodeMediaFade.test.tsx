import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";

// Same xyflow stub as CardNodeLazyEditor.test.tsx (React 18/19 collision).
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { CardNode } from "../components/CardNode";

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("CardNode player", () => {
  it("fades out a playing audio card when the card is closed", () => {
    vi.useFakeTimers();
    const props = {
      id: "n1", type: "card", dragging: false, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
      width: 260, height: 200, selected: false, data: { label: "Card", content: "![](/api/media/a.mp3)" },
    } as unknown as Parameters<typeof CardNode>[0];
    const { container, unmount } = render(<CardNode {...props} />);
    const el = container.querySelector("audio")!;
    expect(el).not.toBeNull();
    let vol = 1;
    Object.defineProperty(el, "paused", { value: false, configurable: true });
    Object.defineProperty(el, "volume", { get: () => vol, set: (v) => { vol = v; }, configurable: true });
    el.pause = vi.fn(); el.load = vi.fn();
    unmount();
    expect(document.body.querySelector("div[hidden]")?.contains(el)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(vol).toBe(0);
    expect(el.pause).toHaveBeenCalled();
  });
});
