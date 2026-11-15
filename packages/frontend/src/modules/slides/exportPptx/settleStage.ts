// Waits until the slide drawn on the measuring stage stops changing: fonts
// loaded, pictures arrived, lazily loaded pieces (a diagram, a formula) in
// place. Reading before that would measure a half-drawn slide.

const PICTURE_WAIT_MS = 8000;
const QUIET_MS = 150;
const SETTLE_CAP_MS = 3000;

const frame = (win: Window) => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));

/** Each wait below ends at once when `signal` aborts, and takes its timers and listeners down with it. */
function onAbort(signal: AbortSignal, listener: () => void): () => void {
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function picturesLoaded(stage: HTMLElement, signal: AbortSignal): Promise<void> {
  // The stage is far off screen, where a lazy picture would never start loading.
  for (const img of stage.querySelectorAll("img")) img.loading = "eager";
  const pending = [...stage.querySelectorAll("img")].filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const finish = () => {
      clearTimeout(timer);
      stopAbort();
      for (const img of pending) { img.removeEventListener("load", done); img.removeEventListener("error", done); }
      resolve();
    };
    const done = () => { left -= 1; if (left === 0) finish(); };
    const timer = setTimeout(finish, PICTURE_WAIT_MS);
    const stopAbort = onAbort(signal, finish);
    for (const img of pending) { img.addEventListener("load", done); img.addEventListener("error", done); }
  });
}

/** Resolves once nothing in the stage has changed for a moment (or after a cap). */
function quiet(stage: HTMLElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(finish, QUIET_MS);
    const cap = setTimeout(finish, SETTLE_CAP_MS);
    const watch = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, QUIET_MS); });
    watch.observe(stage, { subtree: true, childList: true, attributes: true, characterData: true });
    const stopAbort = onAbort(signal, finish);
    function finish() { clearTimeout(timer); clearTimeout(cap); watch.disconnect(); stopAbort(); resolve(); }
  });
}

/** Waits for the stage to settle. After `signal` aborts nothing more is started. */
export async function settleStage(stage: HTMLElement, signal: AbortSignal): Promise<void> {
  const win = stage.ownerDocument.defaultView;
  if (signal.aborted) return;
  await stage.ownerDocument.fonts?.ready;
  if (win && !signal.aborted) await frame(win);
  if (signal.aborted) return;
  await picturesLoaded(stage, signal);
  if (signal.aborted) return;
  await quiet(stage, signal);
  if (win && !signal.aborted) await frame(win);
}
