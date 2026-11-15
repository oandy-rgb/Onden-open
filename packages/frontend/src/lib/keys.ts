// Enter that means "submit", never "pick this IME candidate". While a
// Chinese/Japanese input method is composing, Enter confirms the candidate:
// the browser reports isComposing (or keyCode 229 on Safari/older Chrome,
// which fire keydown after compositionend). One check for every input.

type KeyEventLike = { key: string; nativeEvent?: { isComposing?: boolean; keyCode?: number }; isComposing?: boolean; keyCode?: number };

/** Whether this key event belongs to an IME composition. */
export function isImeComposing(e: KeyEventLike): boolean {
  const native = e.nativeEvent ?? e;
  return native.isComposing === true || native.keyCode === 229;
}

/** A plain Enter press, not one that confirms an IME candidate. */
export function isEnterKey(e: KeyEventLike): boolean {
  return e.key === "Enter" && !isImeComposing(e);
}

/** A plain Escape press, not one that cancels an IME candidate. While composing,
 *  Esc only dismisses the candidate list; closing the field or the dialog
 *  around it would throw the draft away. */
export function isEscapeKey(e: KeyEventLike): boolean {
  return e.key === "Escape" && !isImeComposing(e);
}

/** An onKeyDown handler that runs `handler` on Enter, never mid-composition. */
export function onEnter<E extends KeyEventLike>(handler: (e: E) => void): (e: E) => void {
  return (e) => { if (isEnterKey(e)) handler(e); };
}
