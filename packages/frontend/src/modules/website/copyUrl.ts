import { copyText } from "../../lib/clipboard";

/** Copy a published URL, telling the person how it went (see lib/clipboard). */
export function copyUrl(text: string): void {
  void copyText(text, { what: "url" });
}
