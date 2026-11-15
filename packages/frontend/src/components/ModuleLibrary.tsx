import { ChevronRight } from "lucide-react";
import { useT } from "../lib/i18n";
import { libraryLayout, shownStatus, waitingFor, waitingText, type LibraryRow } from "../lib/libraryLayout";
import type { SettingsTab } from "../lib/settingsTab";
import { FeatureSwitch, TurnOffConfirm, useFeatureSwitch } from "./FeatureSwitch";
import "./ModuleLibrary.css";
import { Pressable } from "./ui";

// The feature list (docs/architecture/module-library.md), Settings › Features:
// the one place that decides which optional features are on. Features are
// grouped by what they are for (lib/libraryLayout, from what each module
// declares); a feature that depends on another sits indented under it and is
// dimmed, with its switch locked, while that one is off. A row is icon, name, a
// one-line sentence, the switch and ›; the row opens that feature's own page
// (its settings), the switch turns it on or off. Features that are off stay in
// their group, quieter. Always-on things (the inbox, handwriting) are not
// features here: they are settings pages of their own. Every built-in function
// is on by default; the ones that spend money, reach outside websites or publish
// to the web (semantic search, RSS, website) start off and ask once when first
// turned on. Only the owner decides, and only online.

type Props = {
  online: boolean;
  /** After a change: refresh so the catalog (module tags, functions) is current. */
  onChanged?: () => void | Promise<void>;
  /** Open the page behind a row: a feature's own page, or the Settings page that holds its settings (AI). */
  onOpenPage?: (page: SettingsTab) => void;
};

export default function ModuleLibrary({ online, onChanged, onOpenPage }: Props) {
  const t = useT();
  const state = useFeatureSwitch(online, onChanged);

  const row = ({ mod, sub }: LibraryRow) => {
    const { id, library } = mod;
    const name = t(library.title);
    const status = shownStatus(mod, state.status);
    const waiting = waitingFor(mod, state.status);
    const sentence = waiting ? waitingText(waiting, t)
      : status === "off" && library.blurbOff ? t(library.blurbOff)
      : library.blurb ? t(library.blurb) : "";
    // Where its settings are (AI: Settings › AI): only the owner can open that page, so only the owner is told and sent there.
    const toSettings = library.settingsTab !== undefined && state.isOwner;
    const showWhere = toSettings && !waiting && !(status === "off" && library.blurbOff);
    const canOpen = onOpenPage !== undefined && (library.settingsTab === undefined || state.isOwner);
    const Icon = library.Icon;
    return (
      <li key={id} className={`module-row${status === "on" ? "" : " is-off"}${waiting ? " is-waiting" : ""}${sub ? " is-sub" : ""}`}
        data-module={id} data-state={status}>
        <div className="module-row-head">
          <Pressable type="button" className="module-row-open" disabled={!canOpen}
            onClick={() => onOpenPage?.(library.settingsTab ?? `module:${id}`)}>
            <Icon size={sub ? 16 : 20} aria-hidden="true" className="module-row-icon" />
            <span className="module-row-text">
              <span className="module-row-name">{name}</span>
              {sentence && <span className="module-row-blurb">{sentence}</span>}
              {showWhere && library.ownerNote && <span className="module-row-blurb">{t(library.ownerNote)}</span>}
            </span>
          </Pressable>
          <FeatureSwitch id={id} name={name} state={state} />
          <ChevronRight size={18} aria-hidden="true" className={`module-row-chevron${canOpen ? "" : " is-none"}`} />
        </div>
        <TurnOffConfirm id={id} name={name} state={state} />
      </li>
    );
  };

  return (
    <section className="module-library" aria-label={t("Features")}>
      {libraryLayout().map((group) => (
        <div className="module-group" data-section={group.id} key={group.id}>
          <h4 className="module-group-title">{t(group.title)}</h4>
          <ul className="module-group-list" aria-label={t(group.title)}>{group.rows.map(row)}</ul>
        </div>
      ))}
      {state.isOwner && !online && <p className="module-library-hint">{t("Connect to change modules.")}</p>}
      {state.element}
    </section>
  );
}
