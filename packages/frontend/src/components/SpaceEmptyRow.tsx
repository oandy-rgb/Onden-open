import { Plus } from "lucide-react";

import { useT } from "../lib/i18n";
import EmptyState from "./EmptyState";
import { Pressable } from "./ui";

/** Under a space's heading in the sidebar while no note of it is listed: offer the ＋ that makes one at the space's
 *  top level (a space just made would otherwise have nowhere to start). `noNotes`: the space holds no note at all,
 *  so it says 「還沒有筆記」; when its notes are only ones the tree leaves out (hidden, made by a module) it says nothing.
 *  Like the heading, a note dropped on this row goes to the space (`data-sb-space-id`, hooks/useSidebarDrag). */
export default function SpaceEmptyRow({ spaceId, label, noNotes, dropping, onCreate }: {
  spaceId: string; label: string; noNotes: boolean; dropping?: boolean; onCreate: (spaceId: string) => void;
}) {
  const t = useT();
  return (
    <div className={dropping ? "sb-space-none sb-drop-into" : "sb-space-none"} data-sb-space-none={spaceId} data-sb-space-id={spaceId}>
      {noNotes ? <EmptyState size="inline" as="span" title={t("No notes yet")} /> : <span />}
      <Pressable type="button" className="sb-space-none__add" onClick={() => onCreate(spaceId)}
        aria-label={t("New note in {space}", { space: label })} title={t("New note in {space}", { space: label })}>
        <Plus size={16} aria-hidden="true" />
      </Pressable>
    </div>
  );
}
