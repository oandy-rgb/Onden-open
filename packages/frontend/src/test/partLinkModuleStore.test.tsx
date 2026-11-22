// usePartLinks (lib/partLinkModule): every screen that asked gets the module when it arrives, whichever screen
// started the load. blockEmbed.test.tsx failed once on CI (public run 44203621228, 2026-11-18) with an inner link
// left as its written text: the inner screen was drawn while the outer screen's load was in flight.
import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { loadPartLinks, loadedPartLinks, usePartLinks } from "../lib/partLinkModule";

function Probe({ name }: { name: string }) {
  const links = usePartLinks("[[A#^aa]]");
  return <span data-testid={name}>{links ? "here" : "waiting"}</span>;
}

describe("usePartLinks", () => {
  it("screens mounted before and during the load all redraw when the module arrives", async () => {
    expect(loadedPartLinks()).toBeNull();
    const first = render(<Probe name="first" />);
    expect(first.getByTestId("first").textContent).toBe("waiting");
    const second = render(<Probe name="second" />); // the load is already in flight
    expect(second.getByTestId("second").textContent).toBe("waiting");
    await act(() => loadPartLinks());
    expect(first.getByTestId("first").textContent).toBe("here");
    expect(second.getByTestId("second").textContent).toBe("here");
  });

  it("a text with no such link never gets the module", () => {
    function Plain() { return <span>{usePartLinks("plain words") ? "here" : "none"}</span>; }
    expect(render(<Plain />).container.textContent).toBe("none");
  });
});
