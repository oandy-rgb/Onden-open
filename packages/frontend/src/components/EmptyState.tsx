import type { ReactNode } from "react";
import { FileText, SearchX, Compass } from "lucide-react";
import "./EmptyState.css";
import { Pressable } from "./ui";

type Variant = "empty" | "noResults" | "notFound";

const DEFAULT_ICON: Record<Variant, ReactNode> = {
  empty: <FileText size={28} strokeWidth={1.5} aria-hidden />,
  noResults: <SearchX size={28} strokeWidth={1.5} aria-hidden />,
  notFound: <Compass size={28} strokeWidth={1.5} aria-hidden />,
};

type Props = {
  /** Picks the default icon + tone. */
  variant?: Variant;
  /** Override the default icon with any node (kept calm at ~28px). */
  icon?: ReactNode;
  title: string;
  /** One calm line of context / reassurance under the title. */
  description?: string;
  /** Optional primary action — renders a single accent button. */
  ctaLabel?: string;
  onCta?: () => void;
  /** Disable the CTA (e.g. while offline). */
  ctaDisabled?: boolean;
  /** Sizing: "panel" for sidebar slots, "page" for full editor pane, "inline" for a
   *  one-line "nothing here" / "Loading…" inside a list, menu or table (title only). */
  size?: "panel" | "page" | "inline";
  /** The element an inline line renders as, so it can sit in a `<ul>` or beside text. */
  as?: "p" | "div" | "li" | "span";
  /** Announce the text to screen readers (a result that appears after typing or loading). */
  role?: "status";
  className?: string;
};

/** Guided empty state — icon + title + one-line description + optional CTA.
 *  Centered and calm; consumes theme tokens so it reads AA in both themes. */
export default function EmptyState({
  variant = "empty",
  icon,
  title,
  description,
  ctaLabel,
  onCta,
  ctaDisabled,
  size = "panel",
  as: Tag = "p",
  role,
  className,
}: Props) {
  if (size === "inline") {
    return (
      <Tag className={`onden-empty-state onden-empty-state--inline${className ? ` ${className}` : ""}`} role={role}>
        {title}
      </Tag>
    );
  }
  return (
    <div
      className={`onden-empty-state onden-empty-state--${size}${className ? ` ${className}` : ""}`}
      data-variant={variant}
    >
      <div className="onden-empty-state-icon">{icon ?? DEFAULT_ICON[variant]}</div>
      <p className="onden-empty-state-title">{title}</p>
      {description && <p className="onden-empty-state-desc">{description}</p>}
      {ctaLabel && onCta && (
        <Pressable
          type="button"
          className="onden-empty-state-cta tap-target"
          onClick={onCta}
          disabled={ctaDisabled}
        >
          {ctaLabel}
        </Pressable>
      )}
    </div>
  );
}
