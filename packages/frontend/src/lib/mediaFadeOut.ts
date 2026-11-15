// A media element that leaves the document is paused by the browser at the
// next stable state (HTML "internal pause steps"), which is a hard cut. So a
// playing one is first moved to a hidden holder that stays in the document,
// and only then faded out and released.
const STEP_MS = 30;
let holder: HTMLElement | null = null;

function getHolder(): HTMLElement {
  if (!holder || !holder.isConnected) {
    holder = document.createElement("div");
    holder.hidden = true;
    holder.setAttribute("aria-hidden", "true");
    document.body.appendChild(holder);
  }
  return holder;
}

function release(el: HTMLMediaElement) {
  el.pause();
  el.remove();
  el.removeAttribute("src");
  el.load();
  if (holder && !holder.firstChild) { holder.remove(); holder = null; }
}

/** Fade out a playing, unmuted element over `ms` and stop it. Call it while the
 *  element is still in the document, before its owner removes it. Anything not
 *  audibly playing is left alone for the caller to remove as usual. */
export function fadeOutDetached(el: HTMLMediaElement, ms = 400): void {
  if (el.paused || el.ended || el.muted) return;
  const box = getHolder();
  if (el.parentElement === box) return;
  box.appendChild(el);
  el.controls = false;
  const start = el.volume;
  // iOS Safari keeps volume read-only: then just let it play out and stop.
  el.volume = start > 0.5 ? start - 0.01 : start + 0.01;
  const adjustable = el.volume !== start;
  el.volume = start;
  if (!adjustable) { setTimeout(() => release(el), ms); return; }
  const steps = Math.max(1, Math.round(ms / STEP_MS));
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (i < steps) { el.volume = start * (1 - i / steps); return; }
    clearInterval(timer);
    el.volume = 0;
    release(el);
  }, STEP_MS);
}
