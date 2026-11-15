// A note's ⋯ › 文字樣式: asks the shell to show the panel (settings/NoteTextStyleSheet), which only
// the shell may import (components do not import settings). Same shape as lib/settingsRequest.
// The request carries the ⋯ that was pressed, so on a desktop the panel opens right below it
// (side by side, below that note's own ⋯) and gives focus back to it; a phone shows a bottom sheet.
import { useEffect, useState } from "react";
import { onWindow } from "./globalEvents";

const EVENT = "onden:open-text-style";

export function openTextStyle(trigger: HTMLElement | null): void {
  window.dispatchEvent(new CustomEvent<HTMLElement | null>(EVENT, { detail: trigger }));
}

/** Whether the panel is asked for, and the ⋯ it was asked from (null: no known place); `close` hides it. */
export function useTextStyleSheet(): { open: boolean; trigger: HTMLElement | null; close: () => void } {
  const [asked, setAsked] = useState<{ trigger: HTMLElement | null } | null>(null);
  useEffect(() => onWindow(EVENT, (event) => setAsked({ trigger: (event as CustomEvent<HTMLElement | null>).detail ?? null })), []);
  return { open: asked !== null, trigger: asked?.trigger ?? null, close: () => setAsked(null) };
}
