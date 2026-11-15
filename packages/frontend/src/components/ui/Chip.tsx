import type { HTMLAttributes } from "react";
import { classNames } from "../../lib/utils";
import "./ui.css";

// A small read-only label. Pick the tone by meaning:
//   neutral  a plain fact ("Current place", "Not published")
//   accent   the good/active state ("Published")
//   info     where something came from ("AI")
//   warning  asks for care ("Asks first", "RSS")
// A chip you can press is a Button, not a Chip.

export type ChipTone = "neutral" | "accent" | "info" | "warning";

type Props = HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone };

export function Chip({ tone = "neutral", className, ...rest }: Props) {
  return <span className={classNames("ui-chip", tone !== "neutral" && `ui-chip--${tone}`, className)} {...rest} />;
}
