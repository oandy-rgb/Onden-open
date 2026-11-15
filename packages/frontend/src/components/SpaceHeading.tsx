import { Users } from "lucide-react";

import { useT } from "../lib/i18n";
import { openSpacesAndMembers } from "../lib/settingsRequest";
import { Pressable } from "./ui";

/** A space's title in the sidebar; a note dragged onto it is offered a move to the space's top level
 *  (hooks/useSidebarDrag). A shared space also opens its own
 *  「成員與權限」 (Settings › 空間與成員, showing only that space). */
export default function SpaceHeading({ spaceId, label, shared, dropping }: { spaceId: string; label: string; shared: boolean; dropping?: boolean }) {
  const t = useT();
  return (
    <div className={dropping ? "sb-space-heading sb-drop-into" : "sb-space-heading"} role="heading" aria-level={3} data-sb-space-id={spaceId}
      title={dropping ? t("Move to {space}", { space: label }) : undefined}>
      <span className="sb-space-heading__label">{label}</span>
      {shared && (
        <Pressable type="button" className="sb-space-members" onClick={() => openSpacesAndMembers(spaceId)}
          aria-label={t("Members and permissions of {space}", { space: label })} title={t("Members and permissions")}>
          <Users size={11} aria-hidden="true" /> <span className="sb-space-members__text">{t("Members and permissions")}</span>
        </Pressable>
      )}
    </div>
  );
}
