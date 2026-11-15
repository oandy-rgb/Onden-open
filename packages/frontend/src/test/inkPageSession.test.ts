// The session of a book of pages (lib/ink/pageSession.ts) with a host of its own: pages are known by
// key only, the host decides how a page's drawing goes into its envelope.
import { describe, expect, it, vi } from "vitest";
import { InkEngine, InkPageSession, emptyInkDocument, type InkDocument } from "../lib/ink";

const engineWith = (doc: InkDocument | null = null) => {
  const engine = new InkEngine({
    committedRenderer: { kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} },
    wetCanvas: document.createElement("canvas"),
    manageCanvasSize: false,
  });
  engine.load(doc);
  return engine;
};
const withStroke = (id: string): InkDocument => ({ ...emptyInkDocument(), strokes: [{ id, toolId: "pen", color: "#000", size: 4, points: [[1, 1], [9, 9]] }] });

type Env = Record<string, InkDocument>;
const newSession = () => new InkPageSession<Env>((env, key, doc) => ({ ...env, [key]: doc }));

describe("InkPageSession", () => {
  it("writes only the pages whose drawing changed since the last apply, once", () => {
    const session = newSession();
    const a = engineWith(), b = engineWith(withStroke("kept"));
    session.attach("a", a, 1.4);
    session.attach("b", b, 1.4);
    const env: Env = {};
    expect(session.apply(env)).toBe(env); // nothing changed: the same object
    a.load(withStroke("new")); // a page's content changes
    const next = session.apply(env);
    expect(Object.keys(next)).toEqual(["a"]);
    expect(session.apply(next)).toBe(next); // idempotent
  });

  it("an engine that leaves keeps its unwritten edits for the next apply, and asks for it at once", () => {
    const session = newSession();
    const settled = vi.fn();
    session.onSettled = settled;
    const a = engineWith();
    session.attach("a", a, 1);
    a.load(withStroke("drawn"));
    session.detach("a", a);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(Object.keys(session.apply({}))).toEqual(["a"]);
    session.detach("a", a); // already gone: nothing more
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("an engine that leaves with nothing new asks for nothing", () => {
    const session = newSession();
    const settled = vi.fn();
    session.onSettled = settled;
    const a = engineWith(withStroke("old"));
    session.attach("a", a, 1);
    session.detach("a", a);
    expect(settled).not.toHaveBeenCalled();
  });

  it("space held reaches every page's engine", () => {
    const session = newSession();
    const a = engineWith(), b = engineWith();
    const spy = [vi.spyOn(a, "setSpaceHeld"), vi.spyOn(b, "setSpaceHeld")];
    session.attach("a", a, 1);
    session.attach("b", b, 1);
    session.setSpaceHeld(true);
    for (const s of spy) expect(s).toHaveBeenCalledWith(true);
  });
});
