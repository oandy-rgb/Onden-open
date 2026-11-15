import { forwardRef, type ButtonHTMLAttributes } from "react";
import { classNames } from "../../lib/utils";
import "./Pressable.css";

// A clickable area that does not look like a button: a list row, card, tree item, swatch or a segment a
// feature draws itself. It is a <button type="button"> with the browser look removed and the app focus ring
// kept; the caller's class draws it. Anything that should look like a button is a Button instead.
export const Pressable = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function Pressable(
  { className, type = "button", ...rest }, ref,
) {
  return <button ref={ref} type={type} className={classNames("ui-pressable", className)} {...rest} />;
});
