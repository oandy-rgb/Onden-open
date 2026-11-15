import { addToast } from "./appStore";
import { t } from "./i18n";

// The only place that touches navigator.clipboard. It is secure-context-only:
// on a LAN-IP HTTP self-host (the phone case) it is `undefined`, where an
// unguarded `.writeText` threw and the copy silently did nothing.

/** Raw write. Rejects when the browser has no clipboard or refuses the write. */
export async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

/** Starts the write within the user's gesture while the text is still being
 *  produced (a server export): Safari refuses a write begun after an await, so
 *  the text goes in as a pending ClipboardItem where one exists. A failure of
 *  `text` itself surfaces as itself; only the clipboard's refusal rejects with
 *  `ClipboardRefused`. */
export class ClipboardRefused extends Error {}
export async function writeClipboardLater(text: Promise<string>): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) {
    text.catch(() => {}); // the missing clipboard is the error to report
    throw new ClipboardRefused("clipboard unavailable", { cause: new Error("clipboard unavailable") });
  }
  let pending: Promise<void> | null = null;
  if (typeof ClipboardItem === "function" && clipboard.write) {
    try {
      pending = clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
    } catch (cause) { pending = Promise.reject(cause); }
    pending.catch(() => {}); // awaited below, after the text's own error
  }
  const value = await text;
  try {
    await (pending ?? clipboard.writeText(value));
  } catch (cause) {
    throw new ClipboardRefused("clipboard refused", { cause });
  }
}

/** What is being copied: picks the hint shown when the copy fails, so the
 *  person knows which field to select by hand. */
export type CopyWhat = "text" | "url" | "link" | "key";

function failureHint(what: CopyWhat): string {
  const target = { url: t("the URL"), link: t("the link"), key: t("the key"), text: t("the text") }[what];
  return t("Couldn't copy — select {what} and copy it manually.", { what: target });
}

/** Copy `text` and tell the person how it went: a "Copied" toast, or a hint to
 *  copy by hand. Resolves true once the clipboard has it. `successToast: false`
 *  is for a button that already shows "Copied" itself; failure is always told. */
export async function copyText(text: string, { what = "text", successToast = true }: { what?: CopyWhat; successToast?: boolean } = {}): Promise<boolean> {
  try {
    await writeClipboard(text);
  } catch {
    addToast(failureHint(what), "error");
    return false;
  }
  if (successToast) addToast(t("Copied"), "success");
  return true;
}
