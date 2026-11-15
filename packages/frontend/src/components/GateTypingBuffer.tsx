import { useEffect, useLayoutEffect, useRef } from "react";
import { isEnterKey } from "../lib/keys";
import { TextArea, layerClass } from "./ui";
import { activeElement, elementAtPoint, insertTextAtCaret } from "../lib/documentAccess";
import { onDocument } from "../lib/globalEvents";

// While the membership gate is up the workspace is inert (Step D, fail-closed):
// nothing in it can take focus, so typing there used to vanish. Every page
// load raises the gate briefly for the cold-start check, which is exactly when
// people start typing. This keeps that typing without opening the workspace:
//   • a field that had focus when the gate rose, or one the user clicks while
//     it is up, becomes the target;
//   • keystrokes go to a hidden box outside the workspace (so an IME such as
//     Zhuyin still composes normally);
//   • when the gate lifts, the target gets focus and the text, and an Enter
//     typed in a one-line field submits its form.
// Typing with no target is still dropped: there is no field it was meant for.

const EDITABLE = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable=''], [contenteditable='true']";

function editableAt(el: Element | null): HTMLElement | null {
  const hit = el?.closest(EDITABLE) as HTMLElement | null;
  return hit && hit.closest(".workspace-grid") ? hit : null;
}

/** Put text where the caret is, the way typing would (input events included). */
function insertTyped(target: HTMLElement, text: string): void {
  if (!text) return;
  if (insertTextAtCaret(text)) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const next = target.value.slice(0, start) + text + target.value.slice(end);
    const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, next);
    target.setSelectionRange(start + text.length, start + text.length);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export default function GateTypingBuffer({ active }: { active: boolean }) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const target = useRef<HTMLElement | null>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  const submit = useRef(false);
  const composing = useRef(false);
  const releaseAfterComposition = useRef<(() => void) | null>(null);

  // Layout effect: the field that had focus is still document.activeElement
  // here; the browser only drops focus from inert content afterwards.
  useLayoutEffect(() => {
    if (!active) return;
    target.current = editableAt(activeElement());
    point.current = null;
    submit.current = false;
    if (target.current) boxRef.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    // The gate's scrim covers the page and catches clicks; remember where the
    // user meant to click and keep their typing for it. The gate's own card
    // (Retry) keeps working.
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.classList.contains("membership-gate")) return;
      e.preventDefault();
      target.current = null;
      point.current = { x: e.clientX, y: e.clientY };
      boxRef.current?.focus({ preventScroll: true });
    };
    return onDocument("mousedown", onMouseDown, true);
  }, [active]);

  useEffect(() => {
    if (active) return;
    const release = () => {
      const box = boxRef.current;
      const text = box?.value ?? "";
      const wantsSubmit = submit.current;
      const resolved = target.current?.isConnected ? target.current
        : point.current ? editableAt(elementAtPoint(point.current.x, point.current.y)) : null;
      const hadIntent = !!target.current || !!point.current;
      target.current = null; point.current = null; submit.current = false;
      if (box) box.value = "";
      if (!resolved) { if (hadIntent && box && box === activeElement()) box.blur(); return; }
      resolved.focus({ preventScroll: true });
      insertTyped(resolved, text);
      // Submit on the next task, once the field's own state has the text.
      if (wantsSubmit && resolved instanceof HTMLInputElement) {
        const form = resolved.form;
        setTimeout(() => { if (form?.isConnected) form.requestSubmit(); }, 0);
      }
    };
    if (composing.current) releaseAfterComposition.current = release;
    else release();
  }, [active]);

  return (
    <TextArea
      ref={boxRef}
      className={`${layerClass.fixed} gate-typing-buffer`}
      aria-hidden="true"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Enter in a one-line field means "submit"; keep it for the release.
        if (isEnterKey(e) && !(target.current instanceof HTMLTextAreaElement)
            && !target.current?.isContentEditable) {
          e.preventDefault();
          submit.current = true;
        }
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => {
        composing.current = false;
        const pending = releaseAfterComposition.current;
        releaseAfterComposition.current = null;
        pending?.();
      }}
    />
  );
}
