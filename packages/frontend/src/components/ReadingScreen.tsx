import { Suspense, useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { classNames } from "../lib/utils";
import { rememberReadingSection } from "../lib/readingHub";
import type { ModuleScreenProps, ReadingSection } from "../modules";
import "./ReadingScreen.css";
import { Pressable } from "./ui";

// The reading hub (閱讀): one page for what waits to be read. Each imported
// module adds its sections (modules/index READING_SECTIONS) and the hub only
// lays them out: the section row on top, the open section below. Today RSS
// is the only section, so the row is hidden and the reader sits directly
// under the 閱讀 title (highlights are ordinary notes,
// found where notes are). Each section is its own `?view=<id>`, so switching
// is ordinary navigation (back works).

type Props = ModuleScreenProps & {
  activeId: string;
  sections: ReadingSection[];
  onSelect: (id: string) => void;
};

export default function ReadingScreen({ activeId, sections, onSelect, onImmersiveChange, ...screen }: Props) {
  const t = useT();
  // An article open on a phone takes the whole screen, section row included.
  const [immersive, setImmersive] = useState(false);
  useEffect(() => { rememberReadingSection(activeId); }, [activeId]);
  const phone = useIsMobile();
  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  if (!active) return null;
  const Section = active.Component;
  return (
    <div className="reading-hub" data-immersive={immersive ? "1" : "0"}>
      {!immersive && (phone ? sections.length > 1 : true) && (
        <header className="reading-hub-head">
          {/* A phone names the page in the top bar. */}
          {!phone && <h1 className="reading-hub-title">{t("Reading")}</h1>}
          {sections.length > 1 && (
            <nav className="reading-hub-sections" aria-label={t("Reading sections")}>
              {sections.map(({ id, label, Icon, Badge }) => (
                <Pressable key={id} type="button" aria-current={id === active.id ? "page" : undefined}
                  className={classNames("reading-hub-section", id === active.id && "active")}
                  onClick={() => { if (id !== active.id) onSelect(id); }}>
                  <Icon size={15} aria-hidden="true" /><span>{t(label)}</span>
                  {Badge && <Badge />}
                </Pressable>
              ))}
            </nav>
          )}
        </header>
      )}
      <div className="reading-hub-body">
        <Suspense fallback={<div className="lazy-loading-pane u-fill" />}>
          <Section {...screen} onImmersiveChange={(next) => { setImmersive(next); onImmersiveChange(next); }} />
        </Suspense>
      </div>
    </div>
  );
}
