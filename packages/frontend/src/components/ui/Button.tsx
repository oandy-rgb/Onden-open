import { forwardRef, type ButtonHTMLAttributes } from "react";
import { classNames } from "../../lib/utils";
import "./ui.css";

// The app's buttons. Pick by what the button means, not how it should look:
//   primary    the one action a form or dialog exists for (Save, Confirm)
//   secondary  everything else beside it (Cancel, Back, Restore to new note)
//   ghost      a quiet action in a toolbar, list row or panel header
//   danger     deletes or overwrites; ask first
//   icon       a square icon-only button; give it an aria-label
// Sizes: md (default) and sm (dense rows and toolbars).

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md";

/** The class string, for the rare element that must stay an <a> or <label>. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return classNames("ui-btn", `ui-btn--${variant}`, size === "sm" && "ui-btn--sm", extra);
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...rest }, ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />;
});
