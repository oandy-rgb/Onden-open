// Reading and changing the document for the screens (allowlist: screens do not
// touch document): the root element's theme attributes and styles, the body
// class, finding or creating elements, the text selection, focus.

const root = (): HTMLElement | null => (typeof document === "undefined" ? null : document.documentElement);

// ── root element: theme, density and the CSS variables settings write ──
export function rootAttribute(name: string): string | null {
  return root()?.getAttribute(name) ?? null;
}

/** Set an attribute on `<html>`; `null` removes it. */
export function setRootAttribute(name: string, value: string | null): void {
  if (value === null) root()?.removeAttribute(name);
  else root()?.setAttribute(name, value);
}

/** Set a CSS variable (or property) on `<html>`; `null` removes it. */
export function setRootStyle(name: string, value: string | null): void {
  if (value === null) root()?.style.removeProperty(name);
  else root()?.style.setProperty(name, value);
}

/** Whether the app resolved to its dark theme. */
export function isDarkTheme(): boolean {
  return rootAttribute("data-theme") === "dark";
}

/** Call `onChange` when one of `<html>`'s attributes changes (the theme switch); returns the stop. */
export function observeRootAttributes(attributes: string[], onChange: () => void): () => void {
  const el = root();
  if (!el || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(el, { attributes: true, attributeFilter: attributes });
  return () => observer.disconnect();
}

/** Call `onChange` when the app's theme switches (the `data-theme` attribute); returns the stop. */
export function observeTheme(onChange: () => void): () => void {
  return observeRootAttributes(["data-theme"], onChange);
}

/** `<meta name=…>` content, created in `<head>` on first use. */
export function setMeta(name: string, content: string): void {
  if (typeof document === "undefined") return;
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
}

/** Turn a class on `<body>` on or off. */
export function setBodyClass(name: string, on: boolean): void {
  document.body.classList.toggle(name, on);
}

// ── finding, creating, focus ──
/** False in a non-browser run (server render, a worker). */
export function hasDocument(): boolean {
  return typeof document !== "undefined";
}

export function elementById(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function queryElement<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/** The topmost element at a viewport point (drag targets); null where the DOM cannot say. */
export function elementAtPoint(x: number, y: number): Element | null {
  return document.elementFromPoint?.(x, y) ?? null;
}

export function activeElement(): Element | null {
  return document.activeElement;
}

/** Whether `el` is `<body>` (nothing specific has focus or is the target). */
export function isBody(el: EventTarget | Element | null): boolean {
  return el === document.body;
}

/** True while the tab is in the background. */
export function isPageHidden(): boolean {
  return document.hidden;
}

/** Create a detached element (an off-screen file input, a canvas, a host div). */
export function createElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

/** Append to `<body>` (a transient dialog host, a hidden file input); returns the removal. */
export function appendToBody(el: HTMLElement): () => void {
  document.body.appendChild(el);
  return () => el.remove();
}

/** Insert text at the caret of the focused field as one undoable edit; false when the browser cannot. */
export function insertTextAtCaret(text: string): boolean {
  return Boolean(document.execCommand?.("insertText", false, text));
}

/** The document's base URL, undefined outside a browser. */
export function documentBaseUrl(): string | undefined {
  return typeof document === "undefined" ? undefined : document.baseURI;
}

/** The text position under a viewport point, whichever of the two browser APIs exists. */
export function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

// ── text selection ──
export function selectionText(): string {
  return window.getSelection()?.toString() ?? "";
}

/** The live selection (null where there is none). */
export function currentSelection(): Selection | null {
  return window.getSelection();
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

export function createRange(): Range {
  return document.createRange();
}

/** Call `onChange` whenever the text selection moves; returns the stop. */
export function onSelectionChange(onChange: () => void): () => void {
  document.addEventListener("selectionchange", onChange);
  return () => document.removeEventListener("selectionchange", onChange);
}
