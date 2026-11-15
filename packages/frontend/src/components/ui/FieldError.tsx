import type { ReactNode } from "react";
import "./FieldError.css";

/** An inline error line (a form, a dialog, a panel): red, announced to screen
 *  readers. The text comes from `writeErrors` / `serverErrors`, not from here.
 *  `className` is for layout only (a retry button beside the text). */
export function FieldError({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `ui-error ${className}` : "ui-error"} role="alert" aria-live="assertive">{children}</span>;
}
