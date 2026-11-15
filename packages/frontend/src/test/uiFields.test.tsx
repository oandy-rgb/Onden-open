import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox, ColorInput, FileInput, Img, Link, Radio, RangeInput, Select, TextArea, TextField } from "../components/ui";

describe("ui form fields", () => {
  it("TextField forwards ref and passes props through", () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextField ref={ref} type="search" aria-label="找" placeholder="搜尋" data-x="1" className="mine" />);
    const el = screen.getByLabelText("找");
    expect(ref.current).toBe(el);
    expect(el).toHaveAttribute("type", "search");
    expect(el).toHaveAttribute("data-x", "1");
    expect(el).toHaveClass("mine");
  });

  it.each([
    ["Checkbox", Checkbox, "checkbox"], ["Radio", Radio, "radio"], ["RangeInput", RangeInput, "range"],
    ["ColorInput", ColorInput, "color"], ["FileInput", FileInput, "file"],
  ] as const)("%s fixes its input type and forwards ref", (_n, Comp, type) => {
    const ref = createRef<HTMLInputElement>();
    render(<Comp ref={ref} aria-label="x" />);
    expect(ref.current).toBe(screen.getByLabelText("x"));
    expect(ref.current).toHaveAttribute("type", type);
  });

  it("Select and TextArea forward ref and props", () => {
    const s = createRef<HTMLSelectElement>(), t = createRef<HTMLTextAreaElement>();
    render(<><Select ref={s} aria-label="s" defaultValue="b"><option value="a">a</option><option value="b">b</option></Select>
      <TextArea ref={t} aria-label="t" rows={3} /></>);
    expect(s.current).toBe(screen.getByLabelText("s"));
    expect(s.current!.value).toBe("b");
    expect(t.current).toHaveAttribute("rows", "3");
  });

  it("adds no class of its own, so the 16px floor comes from the element selectors", () => {
    render(<TextField aria-label="plain" />);
    expect(screen.getByLabelText("plain").getAttribute("class")).toBeNull();
  });
});

describe("ui Link", () => {
  it("adds rel for new-tab links, keeps a caller rel, leaves same-tab links alone", () => {
    const ref = createRef<HTMLAnchorElement>();
    render(<><Link ref={ref} href="https://a" target="_blank">外</Link>
      <Link href="https://b" target="_blank" rel="author">自訂</Link><Link href="/c">內</Link></>);
    expect(ref.current).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("自訂")).toHaveAttribute("rel", "author");
    expect(screen.getByText("內")).not.toHaveAttribute("rel");
  });
});

describe("ui Img", () => {
  it("is lazy and async by default, keeps alt, and lets the caller override", () => {
    const ref = createRef<HTMLImageElement>();
    render(<><Img ref={ref} src="a.png" alt="圖一" /><Img src="b.png" alt="圖二" loading="eager" /><Img src="c.png" alt="" /></>);
    expect(ref.current).toHaveAttribute("loading", "lazy");
    expect(ref.current).toHaveAttribute("decoding", "async");
    expect(screen.getByAltText("圖二")).toHaveAttribute("loading", "eager");
    expect(document.querySelectorAll('img[alt=""]')).toHaveLength(1);
  });
});
