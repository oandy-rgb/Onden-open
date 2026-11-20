// @vitest-environment jsdom
// A screen that asks for the part-link module (lib/partLinkModule) must be redrawn when the module arrives, whichever
// way the arrival interleaves with that screen's own render and effects. Before: a screen that rendered while the module was
// missing, and whose effect ran after another screen's load had finished, saw "already loaded" and never drew again — the
// link stayed as written (`B`) instead of 「B › 開頭」. (CI 2026-11-20: blockEmbed "an embed inside the embedded block".)
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
afterEach(() => vi.resetModules());

describe("usePartLinks", () => {
  it("redraws when the module finished loading between its render and its effect", async () => {
    vi.resetModules();
    const { loadPartLinks, loadedPartLinks, usePartLinks } = await import("../lib/partLinkModule");
    await import("../lib/blockLinks"); // in the module registry, so the load below settles in microtasks (before React's effect task)
    expect(loadedPartLinks()).toBeNull();

    const drawn: boolean[] = [];
    const React = await import("react");
    // Draws first: sees the module missing. The sibling after it starts the load while React is still rendering, so the
    // load settles after this commit and before the passive effects run.
    function Reader() { drawn.push(usePartLinks("[[a/b]]") !== null); return null; }
    function OtherScreen() { void loadPartLinks(); return null; }
    const host = document.createElement("div");
    createRoot(host).render(React.createElement(React.Fragment, null, React.createElement(Reader), React.createElement(OtherScreen)));

    const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0)); // a task: lets React's scheduled render and effects run
    await turn(); await turn(); await loadPartLinks(); await turn();
    expect(drawn[0]).toBe(false);
    expect(drawn.at(-1)).toBe(true);
  });
});
