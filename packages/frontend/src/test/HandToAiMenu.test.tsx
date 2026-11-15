import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setLocalePref } from "../lib/i18n";
import type { HandToAi } from "../hooks/useHandToAi";
import { HAND_ACTIONS, chooseTarget, type HandOptions } from "../lib/handToAi";
import HandToAiMenu from "../components/HandToAiMenu";
import HandToAiPreview from "../components/HandToAiPreview";
import { usePopover } from "../components/ui";

const OPTIONS: HandOptions = {
  can_hand_off: true,
  roles: [{
    actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "api", reason: null, model_name: "m",
    runtimes: [{ kind: "api", available: true }, { kind: "mcp", available: true }],
  }],
};

function fakeHand(over: Partial<HandToAi> = {}): HandToAi {
  return {
    entry: { shown: true, blocked: null }, actions: [...HAND_ACTIONS], noteSkills: [], options: OPTIONS, roles: OPTIONS.roles,
    target: chooseTarget(OPTIONS), pick: {}, setPick: vi.fn(), load: vi.fn(async () => {}),
    run: null, start: vi.fn(async () => true), cancel: vi.fn(async () => {}), retry: vi.fn(), dismiss: vi.fn(), ...over,
  } as unknown as HandToAi;
}

function Harness({ hand, text = "選到的字" }: { hand: HandToAi; text?: string }) {
  const popover = usePopover<HTMLElement>({ open: true, onClose: () => {} });
  return <HandToAiMenu popover={popover} hand={hand} text={text} at={{ x: 1, y: 2 }} label="Selected text" />;
}

beforeEach(() => setLocalePref("en"));
afterEach(cleanup);

describe("the 「AI」 menu", () => {
  it("lists the ready-made actions in order, then Custom, and names who runs it", () => {
    render(<Harness hand={fakeHand()} />);
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Rewrite", "Shorten", "Expand", "Fix grammar", "Translate", "Explain", "Custom…"]);
    expect(screen.getByText("小助手 · API key")).toBeTruthy();
  });

  it("an action hands over exactly the text it was opened with, under that skill", () => {
    const hand = fakeHand();
    render(<Harness hand={hand} text="這一段整段" />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Shorten" }));
    expect(hand.start).toHaveBeenCalledWith({ skill: "shorten", skillName: "Shorten", text: "這一段整段", instruction: undefined, at: { x: 1, y: 2 } });
  });

  it("an action the person switched off isn't there", () => {
    render(<Harness hand={fakeHand({ actions: HAND_ACTIONS.filter((a) => a.id !== "translate") })} />);
    expect(screen.queryByRole("menuitem", { name: "Translate" })).toBeNull();
  });

  it("「⋯」 picks the way for this once and goes back to the actions", () => {
    const hand = fakeHand();
    render(<Harness hand={hand} />);
    fireEvent.click(screen.getByRole("button", { name: "Change who runs this" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Your own AI/ }));
    expect(hand.setPick).toHaveBeenCalledWith({ roleId: "r1", runtime: "mcp" });
    expect(screen.getByRole("menuitem", { name: "Rewrite" })).toBeTruthy();
  });

  it("Custom: one sentence for this once, sent with the text", () => {
    const hand = fakeHand();
    render(<Harness hand={hand} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Custom…" }));
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What to do with this text"), { target: { value: "改成口語" } });
    fireEvent.click(send);
    expect(hand.start).toHaveBeenCalledWith(expect.objectContaining({ text: "選到的字", instruction: "改成口語" }));
  });

  it("Custom can pick one of the person's skills", () => {
    const hand = fakeHand({ noteSkills: [{ id: "k1", name: "我的技能", description: "", appliesTo: [], kind: "note", aiUse: true }] } as unknown as Partial<HandToAi>);
    render(<Harness hand={hand} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Custom…" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "我的技能" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(hand.start).toHaveBeenCalledWith(expect.objectContaining({ skill: "k1", skillName: "我的技能" }));
  });

  it("when it can't run, no action is offered — only the reason", () => {
    render(<Harness hand={fakeHand({ entry: { shown: true, blocked: "Handing to the AI needs a connection." } })} />);
    expect(screen.queryByRole("menuitem", { name: "Rewrite" })).toBeNull();
    expect(screen.getByRole("note").textContent).toBe("Handing to the AI needs a connection.");
  });
});

describe("the card for the request in flight", () => {
  const run = (over: object) => ({ token: 1, skillName: "Shorten", line: "小助手 · API", runtime: "api", phase: "streaming", text: "", sessionId: "s1", failCode: null, session: null, at: { x: 5, y: 5 }, ...over });

  it("shows the preview as it comes and offers Cancel", () => {
    const hand = fakeHand({ run: run({ text: "短一點" }) } as Partial<HandToAi>);
    render(<HandToAiPreview hand={hand} />);
    expect(screen.getByText("短一點")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hand.cancel).toHaveBeenCalled();
  });

  it("another way of running shows the @ai wording instead of a preview", () => {
    const session = { id: "s1", status: "delivered", fail_code: null, agent_name: "小助手", delivered_at: new Date().toISOString() };
    render(<HandToAiPreview hand={fakeHand({ run: run({ runtime: "mcp", phase: "waiting", session }) } as Partial<HandToAi>)} />);
    expect(screen.getByRole("status").textContent).toBe("小助手 received it.");
    expect(document.querySelector(".hand-ai-card-text")).toBeNull();
  });

  it("a failed request says why in a sentence and can be tried again; no code is shown", () => {
    const hand = fakeHand({ run: run({ phase: "failed", failCode: "selection_changed" }) } as Partial<HandToAi>);
    render(<HandToAiPreview hand={hand} />);
    expect(screen.getByRole("status").textContent).not.toMatch(/selection_changed/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(hand.retry).toHaveBeenCalled();
  });

  it("nothing is drawn when no request is in flight", () => {
    render(<HandToAiPreview hand={fakeHand()} />);
    expect(document.querySelector(".hand-ai-card")).toBeNull();
  });
});
