import { forwardRef, type ImgHTMLAttributes } from "react";
import { pageOrigin } from "../../lib/pageUrl";

/** Whether `src` points at another site (an RSS article's picture, a pasted image link). */
export function isOtherSite(src: string | undefined): boolean {
  const origin = pageOrigin();
  if (!src || !origin) return false;
  // A relative address resolves to this page's origin; a data: or blob: picture never leaves the device.
  try {
    const url = new URL(src, origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin;
  } catch { return false; }
}

/** The app's `<img>`. `alt` is required (use "" for a decorative image); loading is lazy and
 *  decoding async unless the caller says otherwise (e.g. `loading="eager"` for the first image).
 *  A picture from another site is asked for without a Referer: many sites refuse pictures
 *  linked from elsewhere (feed articles came out blank, 2026-11-02) and the address of your
 *  note is nobody else's business. A caller can still pass its own `referrerPolicy`. */
export const Img = forwardRef<HTMLImageElement, Omit<ImgHTMLAttributes<HTMLImageElement>, "alt"> & { alt: string }>(function Img(
  { alt, loading = "lazy", decoding = "async", referrerPolicy, ...rest }, ref,
) {
  const policy = referrerPolicy ?? (isOtherSite(rest.src) ? "no-referrer" : undefined);
  return <img ref={ref} alt={alt} loading={loading} decoding={decoding} referrerPolicy={policy} {...rest} />;
});
