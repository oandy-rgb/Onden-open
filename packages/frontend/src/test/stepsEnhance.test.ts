// The step-by-step player (@onden/markdown stepsEnhance.ts) over server-drawn markup:
// the bar, the keys, the swipe, "show all", reduced motion and the code transition.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flipCode, installStepsPlayer, installStepsPlayers, pairedCodes, splitCodeLines } from "@onden/markdown/steps-enhance";

const code = (lang: string, html: string) => `<pre><code class="hljs language-${lang}">${html}</code></pre>`;
const FIGURE = (steps: string[]) => `<div class="md-steps" data-steps data-l-prev="上一步" data-l-next="下一步" data-l-expand="全部展開" data-l-collapse="一次一步" data-l-count="第 {n} 步／共 {m} 步">
  <div class="md-steps-stage">${steps.map((body, i) => `<section class="md-step" data-step-title="Title ${i + 1}"><h3>Title ${i + 1}</h3><div>${body}</div></section>`).join("")}</div></div>`;

const root = () => document.querySelector<HTMLElement>(".md-steps")!;
const shown = () => [...document.querySelectorAll(".md-step.is-active")].map((s) => s.getAttribute("data-step-title"));
const press = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const key = (k: string, target: Element = root()) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

function mockMotion(reduced: boolean): void {
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

beforeEach(() => { mockMotion(false); });
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("the player", () => {
  beforeEach(() => { document.body.innerHTML = FIGURE(["<p>a</p>", "<p>b</p>", "<p>c</p>"]); installStepsPlayers(document); });

  it("starts on the first step with a bar in the site's words", () => {
    expect(root().classList.contains("is-player")).toBe(true);
    expect(shown()).toEqual(["Title 1"]);
    expect(document.querySelector(".md-steps-status")!.textContent).toBe("第 1 步／共 3 步 · Title 1");
    expect(document.querySelector<HTMLButtonElement>(".md-steps-btn")!.getAttribute("aria-label")).toBe("上一步");
    expect((document.querySelectorAll(".md-steps-btn")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("the buttons move one step and stop at the ends", () => {
    const [prev, next] = document.querySelectorAll<HTMLButtonElement>(".md-steps-btn");
    next!.click(); next!.click();
    expect(shown()).toEqual(["Title 3"]);
    expect(next!.disabled).toBe(true);
    prev!.click();
    expect(shown()).toEqual(["Title 2"]);
    expect(document.querySelector(".md-steps-status")!.textContent).toContain("第 2 步／共 3 步");
  });

  it("hides the other steps from reading and focus", () => {
    const steps = document.querySelectorAll(".md-step");
    expect(steps[0]!.hasAttribute("inert")).toBe(false);
    expect(steps[1]!.hasAttribute("inert")).toBe(true);
    expect(steps[1]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("the arrow keys, Home and End move when the figure has focus", () => {
    key("ArrowRight"); key("ArrowRight");
    expect(shown()).toEqual(["Title 3"]);
    key("ArrowLeft");
    expect(shown()).toEqual(["Title 2"]);
    key("Home");
    expect(shown()).toEqual(["Title 1"]);
    key("End");
    expect(shown()).toEqual(["Title 3"]);
  });

  it("leaves the key alone while typing in a field of a step", () => {
    const step = document.querySelector(".md-step")!;
    const input = document.createElement("input");
    step.append(input);
    key("ArrowRight", input);
    expect(shown()).toEqual(["Title 1"]);
  });

  it("a sideways swipe moves, a vertical one does not", () => {
    const stage = document.querySelector(".md-steps-stage")!;
    const touch = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true }) as Event & { changedTouches: unknown };
      e.changedTouches = [{ clientX: x, clientY: y }];
      stage.dispatchEvent(e);
    };
    touch("touchstart", 200, 100); touch("touchend", 100, 110);
    expect(shown()).toEqual(["Title 2"]);
    touch("touchstart", 100, 100); touch("touchend", 90, 300);
    expect(shown()).toEqual(["Title 2"]);
    touch("touchstart", 100, 100); touch("touchend", 220, 100);
    expect(shown()).toEqual(["Title 1"]);
  });

  it("a swipe that starts on a code block that scrolls sideways does not change the step", () => {
    const pre = document.createElement("pre");
    pre.style.overflowX = "auto";
    pre.textContent = "a very long line";
    document.querySelector(".md-step")!.append(pre);
    Object.defineProperty(pre, "scrollWidth", { value: 800 });
    Object.defineProperty(pre, "clientWidth", { value: 300 });
    const stage = document.querySelector(".md-steps-stage")!;
    const touch = (target: Element, type: string, x: number) => {
      const e = new Event(type, { bubbles: true }) as Event & { changedTouches: unknown };
      e.changedTouches = [{ clientX: x, clientY: 100 }];
      target.dispatchEvent(e);
    };
    touch(pre, "touchstart", 250); touch(pre, "touchend", 100);
    expect(shown()).toEqual(["Title 1"]);
    touch(stage, "touchstart", 250); touch(stage, "touchend", 100); // off the code: the step changes
    expect(shown()).toEqual(["Title 2"]);
  });

  it("Home, End and the Page keys inside a step are left to the page; the arrows still move", () => {
    const link = document.createElement("a");
    link.href = "#x"; link.textContent = "x";
    document.querySelector(".md-step")!.append(link);
    key("End", link);
    expect(shown()).toEqual(["Title 1"]);
    key("ArrowRight", link);
    expect(shown()).toEqual(["Title 2"]);
  });

  it("show all lays every step open and turns the keys off; pressing again returns", () => {
    press(".md-steps-all");
    expect(root().classList.contains("is-expanded")).toBe(true);
    expect([...document.querySelectorAll(".md-step")].every((s) => !s.hasAttribute("inert"))).toBe(true);
    expect(document.querySelector(".md-steps-all")!.textContent).toBe("一次一步");
    key("ArrowRight");
    expect(shown()).toEqual(["Title 1"]);
    press(".md-steps-all");
    expect(root().classList.contains("is-expanded")).toBe(false);
    expect(document.querySelectorAll(".md-step")[1]!.hasAttribute("inert")).toBe(true);
  });

  it("is wired once, and can be undone", () => {
    const stop = installStepsPlayer(root());
    expect(document.querySelectorAll(".md-steps-bar")).toHaveLength(1);
    stop(); // a second install returned a no-op
    expect(document.querySelectorAll(".md-steps-bar")).toHaveLength(1);
  });

  it("uninstalling restores the plain list", () => {
    document.body.innerHTML = FIGURE(["a", "b"]);
    const stop = installStepsPlayer(root());
    stop();
    expect(document.querySelector(".md-steps-bar")).toBeNull();
    expect(root().classList.contains("is-player")).toBe(false);
    expect(document.querySelector(".md-step[inert]")).toBeNull();
  });

  it("a single step has no way to go anywhere", () => {
    document.body.innerHTML = FIGURE(["only"]);
    installStepsPlayers(document);
    const [prev, next] = document.querySelectorAll<HTMLButtonElement>(".md-steps-btn");
    expect([prev!.disabled, next!.disabled]).toEqual([true, true]);
    expect(document.querySelector(".md-steps-status")!.textContent).toContain("第 1 步／共 1 步");
  });
});

describe("splitCodeLines", () => {
  const codeEl = (html: string) => { document.body.innerHTML = code("js", html); return document.querySelector("code")!; };

  it("cuts into one element per line and drops the final newline", () => {
    const lines = splitCodeLines(codeEl("a\nb\nc\n"));
    expect(lines.map((l) => l.textContent)).toEqual(["a", "b", "c"]);
  });

  it("keeps a colour span open across a line break on each line", () => {
    const lines = splitCodeLines(codeEl(`<span class="hljs-comment">/* one\ntwo */</span>\nx`));
    expect(lines.map((l) => l.innerHTML)).toEqual([
      `<span class="hljs-comment">/* one</span>`, `<span class="hljs-comment">two */</span>`, "x",
    ]);
  });

  it("keeps an empty line", () => {
    expect(splitCodeLines(codeEl("a\n\nb\n")).map((l) => l.textContent)).toEqual(["a", "", "b"]);
  });

  it("does not change the code", () => {
    const el = codeEl("a\nb\n");
    splitCodeLines(el);
    expect(el.innerHTML).toBe("a\nb\n");
  });
});

describe("the code transition", () => {
  it("pairs the nth code block of the same language", () => {
    document.body.innerHTML = `<div id="a">${code("js", "x")}${code("py", "y")}</div><div id="b">${code("js", "x2")}${code("js", "y2")}</div>`;
    const pairs = pairedCodes(document.querySelector("#a")!, document.querySelector("#b")!);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]![1].textContent).toBe("x2");
  });

  function setup(): { from: HTMLElement; to: HTMLElement; calls: Array<{ el: Element; keyframes: Keyframe[] }> } {
    document.body.innerHTML = `<div id="a">${code("js", "keep\ngone\nmove\n")}</div><div id="b">${code("js", "new\nkeep\nmove\n")}</div>`;
    const calls: Array<{ el: Element; keyframes: Keyframe[] }> = [];
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
      calls.push({ el: this, keyframes: keyframes as Keyframe[] });
      return { finished: new Promise(() => {}), cancel() {} } as unknown as Animation;
    };
    // line boxes: 20px high, code starts at 0 (a) and 100 (b)
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      const inA = !!el.closest("#a");
      const lines = (el.textContent ?? "").split("\n").filter((_, i, all) => i < all.length - 1 || all[i] !== "").length;
      return { top: inA ? 0 : 100, left: 0, width: 300, height: el.tagName === "CODE" ? lines * 20 : 0, right: 300, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    return { from: document.querySelector("#a code")!, to: document.querySelector("#b code")!, calls };
  }

  afterEach(() => { delete (Element.prototype as { animate?: unknown }).animate; });

  it("slides kept lines from where they were, fades new lines in and removed lines out", () => {
    const { from, to, calls } = setup();
    const flip = flipCode(from, to);
    const overlay = document.querySelector("#b .md-flip")!;
    expect(overlay).not.toBeNull();
    expect(to.style.visibility).toBe("hidden");
    expect([...overlay.children].map((l) => l.textContent)).toEqual(["new", "keep", "move", "gone"]);
    expect(overlay.children[0]!.classList.contains("md-line-added")).toBe(true);
    expect(overlay.children[3]!.classList.contains("md-line-removed")).toBe(true);
    const slide = (name: string) => calls.find((c) => c.el.textContent === name && "transform" in c.keyframes[0]!)!;
    // "keep": was line 0 of a (top 0), is line 1 of b (top 100+20) -> moves up by 120
    expect(slide("keep").keyframes[0]!.transform).toBe("translateY(-120px)");
    // "move": was line 2 (top 40), now line 2 (top 140) -> up by 100
    expect(slide("move").keyframes[0]!.transform).toBe("translateY(-100px)");
    expect(calls.some((c) => c.el.textContent === "new" && c.keyframes[0]!.opacity === 0)).toBe(true);
    expect(calls.some((c) => c.el.textContent === "gone" && c.keyframes[1]!.opacity === 0)).toBe(true);
    flip.finish();
    expect(document.querySelector(".md-flip")).toBeNull();
    expect(to.style.visibility).toBe("");
  });

  it("with reduced motion a step change draws no transition", async () => {
    mockMotion(true);
    document.body.innerHTML = FIGURE([code("js", "a\n"), code("js", "a\nb\n")]);
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    installStepsPlayers(document);
    document.querySelectorAll<HTMLElement>(".md-steps-btn")[1]!.click();
    expect(shown()).toEqual(["Title 2"]);
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector(".md-flip")).toBeNull();
  });

  it("without it a step change between two code blocks plays one", () => {
    document.body.innerHTML = FIGURE([code("js", "a\n"), code("js", "a\nb\n")]);
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel() {} }));
    Element.prototype.animate = animate as never;
    installStepsPlayers(document);
    document.querySelectorAll<HTMLElement>(".md-steps-btn")[1]!.click();
    expect(animate).toHaveBeenCalled();
    expect(document.querySelector(".md-flip")).not.toBeNull();
    document.querySelectorAll<HTMLElement>(".md-steps-btn")[0]!.click(); // a newer choice ends the old transition
    expect(document.querySelectorAll(".md-flip").length).toBeLessThanOrEqual(1);
  });
});
