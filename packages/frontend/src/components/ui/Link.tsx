import { forwardRef, type AnchorHTMLAttributes } from "react";

/** The app's `<a>`. A link that opens a new tab gets `rel="noopener noreferrer"` unless the caller
 *  sets its own `rel`, so the opened page can neither script nor see this one. */
export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link(
  { target, rel, ...rest }, ref,
) {
  return <a ref={ref} target={target} rel={rel ?? (target === "_blank" ? "noopener noreferrer" : undefined)} {...rest} />;
});
