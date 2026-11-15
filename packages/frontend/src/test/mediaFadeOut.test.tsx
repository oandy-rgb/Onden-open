import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { fadeOutDetached } from "../lib/mediaFadeOut";

function mockPlaying(el: HTMLMediaElement, opts: { paused?: boolean; muted?: boolean } = {}) {
  let vol = 1;
  Object.defineProperty(el, "paused", { value: opts.paused ?? false, configurable: true });
  Object.defineProperty(el, "volume", { get: () => vol, set: (v) => { vol = v; }, configurable: true });
  el.muted = opts.muted ?? false;
  el.pause = vi.fn();
  el.load = vi.fn();
}

const holderOf = () => document.body.querySelector("div[hidden][aria-hidden='true']");

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("fadeOutDetached", () => {
  it("moves a playing element aside, lowers volume to 0, then pauses and removes it", () => {
    const el = document.createElement("audio");
    document.body.append(el);
    mockPlaying(el);
    fadeOutDetached(el, 400);
    expect(holderOf()?.contains(el)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(el.volume).toBeGreaterThan(0);
    expect(el.volume).toBeLessThan(1);
    vi.advanceTimersByTime(250);
    expect(el.volume).toBe(0);
    expect(el.pause).toHaveBeenCalled();
    expect(el.isConnected).toBe(false);
    expect(holderOf()).toBeNull();
  });

  it("leaves paused and muted elements where they are", () => {
    const a = document.createElement("audio");
    const b = document.createElement("audio");
    document.body.append(a, b);
    mockPlaying(a, { paused: true });
    mockPlaying(b, { muted: true });
    fadeOutDetached(a); fadeOutDetached(b);
    expect(holderOf()).toBeNull();
    expect(a.parentElement).toBe(document.body);
    expect(b.parentElement).toBe(document.body);
  });

  it("just waits then pauses when volume is read-only", () => {
    const el = document.createElement("video");
    document.body.append(el);
    mockPlaying(el);
    Object.defineProperty(el, "volume", { get: () => 1, set: () => {}, configurable: true });
    fadeOutDetached(el, 400);
    vi.advanceTimersByTime(399);
    expect(el.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(el.pause).toHaveBeenCalled();
  });
});

describe("players fade when React removes them", () => {
  const md = "intro\n\n![](/api/media/a.mp3)\n\nafter";
  function setup(source: string) {
    const r = render(<MarkdownRenderer nodes={[]}>{source}</MarkdownRenderer>);
    const el = r.container.querySelector("audio")!;
    mockPlaying(el);
    return { ...r, el };
  }

  it("whole tree unmount", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { el, unmount } = setup(md);
    unmount();
    expect(holderOf()?.contains(el)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(el.pause).toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("only that line deleted", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { el, rerender, container } = setup(md);
    rerender(<MarkdownRenderer nodes={[]}>{"intro\n\nafter"}</MarkdownRenderer>);
    expect(container.querySelector("audio")).toBeNull();
    expect(holderOf()?.contains(el)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(el.pause).toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("not playing: removed with no holder", () => {
    const { el, unmount } = setup(md);
    Object.defineProperty(el, "paused", { value: true, configurable: true });
    unmount();
    expect(holderOf()).toBeNull();
  });
});
