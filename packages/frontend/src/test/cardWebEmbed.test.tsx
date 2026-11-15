// A canvas card whose body is one bare URL: only trusted embed providers
// (YouTube / Vimeo) frame on their own; any other page is a link card that
// loads when tapped, so opening a board never contacts a stranger's server.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));
import { CardNode } from "../components/CardNode";

function renderCard(content: string) {
  const props = { id: "n1", type: "card", selected: false, data: { label: "Card", content } } as unknown as Parameters<typeof CardNode>[0];
  return render(<CardNode {...props} />).container;
}

describe("web embed card", () => {
  it("frames a trusted provider straight away, at its embed address", () => {
    const box = renderCard("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(box.querySelector("iframe")?.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("shows any other page as a link card with no frame", () => {
    const box = renderCard("https://tracker.example/page");
    expect(box.querySelector("iframe")).toBeNull();
    expect(box.querySelector(".card-node-webembed-link")).not.toBeNull();
  });

  it("a host that merely ends like a trusted one is not trusted", () => {
    expect(renderCard("https://evilyoutube.com/watch?v=dQw4w9WgXcQ").querySelector("iframe")).toBeNull();
    expect(renderCard("https://evilvimeo.com/123456").querySelector("iframe")).toBeNull();
  });

  it("loads the other page only after a tap, without popups", () => {
    const box = renderCard("https://tracker.example/page");
    fireEvent.click(box.querySelector(".card-node-webembed-link button")!);
    const frame = box.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://tracker.example/page");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });
});
