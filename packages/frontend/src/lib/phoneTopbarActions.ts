import { useEffect, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";

// What a page asks the phone's top bar to hold. On a phone the page has no
// title row (the top bar names the page), so the buttons that used to sit on
// that row go beside search instead (components/AppTopbar).
//
//   usePhoneTopbarActions(phone ? [{ id: "add-task", label: t("Add task"), Icon: Plus, onSelect: add }] : []);
//
// A page registers while it is mounted; two pages are never open at once.

export type PhoneTopbarAction = {
  id: string;
  /** Shown as the button's name (i18n'd by the page). */
  label: string;
  Icon: LucideIcon;
  /** Gets the pressed button, for a menu that opens beside it. */
  onSelect: (button: HTMLElement) => void;
  /** A small dot on the icon: the page is narrowed or has something to see. */
  marked?: boolean;
};

const NONE: readonly PhoneTopbarAction[] = [];
let current: readonly PhoneTopbarAction[] = NONE;
const listeners = new Set<() => void>();

function set(next: readonly PhoneTopbarAction[]) {
  const same = next.length === current.length
    && next.every((a, i) => a.id === current[i]?.id && a.label === current[i]?.label && a.onSelect === current[i]?.onSelect && a.marked === current[i]?.marked);
  if (same) return;
  current = next.length ? next : NONE;
  for (const l of listeners) l();
}

/** The actions the open page put in the top bar. */
export function usePhoneTopbarActionList(): readonly PhoneTopbarAction[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => NONE,
  );
}

/** Put `actions` in the phone top bar while the calling page is mounted. */
export function usePhoneTopbarActions(actions: readonly PhoneTopbarAction[]): void {
  useEffect(() => { set(actions); });
  useEffect(() => () => set(NONE), []);
}
