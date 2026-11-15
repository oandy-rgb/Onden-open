// Input-method composition in real Chromium, through the DevTools protocol.
//
// A person typing Zhuyin / Pinyin does not send characters: the input method
// holds an underlined "composition" (ㄋㄧ), the candidate list changes it
// (你), Enter or a digit key picks the candidate, Esc throws it away. Playwright's
// keyboard cannot do that, so these helpers drive the same browser path:
//   Input.imeSetComposition  → compositionstart / compositionupdate, text still pending
//   Input.insertText         → the pending text becomes real (compositionend)
//   Input.dispatchKeyEvent   → a key that arrives while composing (keydown with isComposing)
// Real keyboards (Gboard, Samsung, iOS Zhuyin) and Safari are not covered; see docs/agents/testing.md.
import type { CDPSession, Page } from "@playwright/test";

export type Ime = {
  /** The composition so far, e.g. "ㄋ", "ㄋㄧ", "你": each call replaces the previous one. */
  compose(text: string): Promise<void>;
  /** Zhuyin typed one key at a time, ending on the candidate the person picks. */
  composeSteps(steps: string[]): Promise<void>;
  /** Enter, as the input method receives it: keydown with isComposing, keyCode 229. */
  enterWhileComposing(): Promise<void>;
  /** Esc, as the input method receives it: the page sees the key, the input method owns it. */
  escapeWhileComposing(): Promise<void>;
  /** Choose the candidate: Enter reaches the page, then the text becomes final. */
  pickWithEnter(text: string): Promise<void>;
  /** Final text without a candidate key (a space or digit pick, or a paste-like insert). */
  commit(text: string): Promise<void>;
  /** Throw the composition away (Esc in the candidate list): the text under it comes back. */
  cancel(): Promise<void>;
  /** Whether the focused element is composing right now. */
  composing(): Promise<boolean>;
};

export async function startIme(page: Page): Promise<Ime> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  // The page learns about composition from these events; recording them lets a test
  // assert that a key really arrived mid-composition rather than after it.
  await page.evaluate(() => {
    const w = window as unknown as { __imeLog?: string[] };
    if (w.__imeLog) return;
    w.__imeLog = [];
    for (const type of ["compositionstart", "compositionend", "keydown"]) {
      document.addEventListener(type, (e) => {
        const k = e as KeyboardEvent;
        w.__imeLog!.push(type === "keydown" ? `keydown:${k.key}:${k.isComposing}` : type);
      }, true);
    }
  });
  const setComposition = (text: string) =>
    cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  const key = (name: "Enter" | "Escape", code: number) => cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
  }).then(() => cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code }));
  return {
    compose: setComposition,
    async composeSteps(steps) { for (const step of steps) await setComposition(step); },
    // The key code a real input method reports for keys it handles is 229; the page must
    // tell composition from isComposing, which Blink sets from the live composition.
    enterWhileComposing: () => key("Enter", 13),
    escapeWhileComposing: () => key("Escape", 27),
    async pickWithEnter(text) {
      await key("Enter", 13);
      await cdp.send("Input.insertText", { text });
    },
    commit: (text) => cdp.send("Input.insertText", { text }),
    cancel: () => setComposition(""),
    composing: () => page.evaluate(() => {
      const w = window as unknown as { __imeLog?: string[] };
      const log = w.__imeLog ?? [];
      const last = [...log].reverse().find((e) => e.startsWith("composition"));
      return last === "compositionstart";
    }),
  };
}

/** Keys seen by the page since startIme, e.g. "keydown:Enter:true". */
export const keysSeen = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __imeLog?: string[] }).__imeLog ?? []);
