import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Img } from "../components/ui/Img";
import { pageOrigin } from "../lib/pageUrl";

// A picture from another site goes out without a Referer (hotlink-protected feed images
// came out blank); our own pictures and an explicit policy are left alone.
describe("Img referrer", () => {
  it("asks for another site's picture without a Referer", () => {
    const { container } = render(<Img src="https://images.example.org/a.png" alt="" />);
    expect(container.querySelector("img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("leaves our own pictures and relative paths alone", () => {
    const { container } = render(<><Img src={`${pageOrigin()}/api/media/x`} alt="" /><Img src="/api/media/y" alt="" /></>);
    for (const img of container.querySelectorAll("img")) expect(img.getAttribute("referrerpolicy")).toBeNull();
  });
  it("treats a protocol-relative address as another site and inline pictures as ours", () => {
    const { container } = render(<><Img src="//images.example.org/a.png" alt="" /><Img src="data:image/png;base64,AAAA" alt="" /></>);
    const [far, inline] = container.querySelectorAll("img");
    expect(far.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(inline.getAttribute("referrerpolicy")).toBeNull();
  });
  it("keeps a policy the caller chose", () => {
    const { container } = render(<Img src="https://images.example.org/a.png" alt="" referrerPolicy="origin" />);
    expect(container.querySelector("img")!.getAttribute("referrerpolicy")).toBe("origin");
  });
});
