import { useId, type ReactNode } from "react";
import "./DataRow.css";

/** One line of Settings › Your Data: what it does on the left (title, then at
 *  most two muted lines), its one button on the right (below the text on a
 *  phone). `children` is what that button opens up (progress, results, errors)
 *  and spans the full width. The action group is named by the title so the
 *  generic button texts ("Choose file…") stay distinguishable. */
export function DataRow({ title, hint, note, action, children, className }: {
  title: string;
  /** A hook for the widget that owns the row (tests find it by this). */
  className?: string;
  hint: ReactNode;
  /** A second, fainter line: what the action leaves out. */
  note?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <div className={className ? `settings-data-row ${className}` : "settings-data-row"}>
      <div className="settings-data-row-text">
        <p id={titleId} className="settings-data-row-title">{title}</p>
        <p className="settings-data-row-hint">{hint}</p>
        {note && <p className="settings-data-row-hint settings-data-row-hint--faint">{note}</p>}
      </div>
      {action && <div className="settings-data-row-action" role="group" aria-labelledby={titleId}>{action}</div>}
      {children && <div className="settings-data-row-extra">{children}</div>}
    </div>
  );
}
