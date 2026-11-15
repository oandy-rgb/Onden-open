import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useT } from "../lib/i18n";
import { Button, CloseButton, Pressable } from "./ui";
import "./PanelHeader.css";

/**
 * The header of an action panel (Ask, Users & Agents, Review, Reader, …).
 * On a phone those panels fill the screen (`.node-action-panel`), so the
 * header is one padded row: 「‹ 返回」 at the left, then the icon beside the
 * title, then `children` (a count or status). The desktop drawer keeps the
 * icon + title with its close button at the right.
 *
 * `onClose` is "go back to where you were" in both; without it the header is
 * a plain title row (a panel embedded in a page).
 *
 *   <PanelHeader icon={<Users size={16} />} title={t("Users & Agents")} onClose={onClose} />
 */
export default function PanelHeader({ icon, title, onClose, closeAs = "text", children }: {
  icon: ReactNode;
  title: string;
  onClose?: () => void;
  /** Desktop close control: the word 「關閉」, or just an × (Ask's slim drawer). */
  closeAs?: "text" | "icon";
  children?: ReactNode;
}) {
  const t = useT();
  const phone = useIsMobile();
  const heading = <h2 className="panel-header-title">{icon}{title}</h2>;
  if (phone) {
    return (
      <div className="panel-header compact panel-header--phone">
        {onClose && (
          <Pressable type="button" className="panel-back" onClick={onClose}>
            <ChevronLeft size={20} aria-hidden="true" /><span>{t("Back")}</span>
          </Pressable>
        )}
        {heading}
        {children}
      </div>
    );
  }
  return (
    <div className="panel-header compact">
      {heading}
      {children}
      {onClose && (closeAs === "icon"
        ? <CloseButton className="push-right" title={t("Close")} onClick={onClose} />
        : <Button variant="ghost" className="push-right" onClick={onClose}>{t("Close")}</Button>)}
    </div>
  );
}
