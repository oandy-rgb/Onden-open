import { Suspense } from "react";
import type { LucideIcon } from "lucide-react";
import type { ContentNode, Tag } from "../lib/api";
import { useTagRows } from "../lib/appStore";
import { noteSwitchOn } from "../lib/noteSwitch";
import { useT } from "../lib/i18n";
import { useNoteSwitch } from "../hooks/useNoteSwitch";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { noteSwitchesOf, type NoteSwitchSpec } from "../modules";
import { Switch } from "./ui";
import "./InfoTagsTab.css";
import { isNote } from "@onden/markdown/contract";

// The info panel's switches of what this note IS to a feature (「當成技能」),
// under the note's own tags: one row per imported module whose note switch is
// ON for this note (FrontendModule.noteSwitch), with the module's fields below
// it; switching it off takes the row away. An off switch is not shown here: it
// is turned on from the note's ⋯ menu or ⌘K (modules/index NOTE_COMMANDS). The
// module's inside tag is what the switch writes; it is never listed as a tag
// (lib/nodeTags isNoteSwitchTag).

/** The switches shown for `node`: the ones that are on; none for a note the
 *  person cannot edit or that is not a plain note (a tag, a board). */
export function useNoteSwitchList(node: ContentNode | null, canEdit: boolean) {
  const isImported = useModuleFilter();
  const tags = useTagRows() ?? NO_TAGS;
  if (!node || !canEdit || !isNote(node)) return [];
  return noteSwitchesOf(isImported).filter(({ moduleId }) => noteSwitchOn(node, moduleId, tags));
}

const NO_TAGS: Tag[] = [];

export default function NoteSwitches({ node, switches }: { node: ContentNode; switches: ReturnType<typeof useNoteSwitchList> }) {
  if (switches.length === 0) return null;
  return (
    <section className="info-note-switches">
      {switches.map(({ moduleId, Icon, spec }) => <NoteSwitchRow key={moduleId} node={node} moduleId={moduleId} Icon={Icon} spec={spec} />)}
    </section>
  );
}

function NoteSwitchRow({ node, moduleId, Icon, spec }: { node: ContentNode; moduleId: string; Icon: LucideIcon; spec: NoteSwitchSpec }) {
  const t = useT();
  const { on, busy, set } = useNoteSwitch(node, moduleId);
  const { Fields } = spec;
  return (
    <div className="info-note-switch" data-module={moduleId}>
      <div className="info-note-switch-row">
        <Icon size={16} aria-hidden="true" />
        <span className="info-note-switch-text">
          <span className="info-note-switch-label">{t(spec.label)}</span>
        </span>
        <Switch on={on} label={t(spec.label)} disabled={busy} onChange={(next) => void set(next)} />
      </div>
      {on && Fields && (
        <Suspense fallback={null}><Fields node={node} readOnly={false} /></Suspense>
      )}
    </div>
  );
}
