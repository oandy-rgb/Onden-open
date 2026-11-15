import type { ButtonHTMLAttributes } from "react";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { Button, type ButtonSize } from "./Button";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Names what it closes when "Close" is not enough ("Leave the slides"). */
  label?: string;
  size?: ButtonSize;
};

/** The ✕ of a dialog, sheet or panel header. One icon size, and the touch size of
 *  `Button variant="icon"` (44px where the pointer is a finger). */
export function CloseButton({ label, size = "md", ...rest }: Props) {
  const t = useT();
  return (
    <Button variant="icon" size={size} aria-label={label ?? t("Close")} {...rest}>
      <X size={size === "sm" ? 16 : 18} aria-hidden="true" />
    </Button>
  );
}
