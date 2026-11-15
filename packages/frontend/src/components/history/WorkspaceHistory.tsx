// The workspace History screen (docs/architecture/history-api.md): two tabs, 「變更」 (the days'
// edits and AI runs) and 「最近刪除」. The tab last used is remembered on this device.
// Wide enough (the page's own width, see detailSlot.ts), the list sits on the left and the
// selected row's detail on the right; narrow, a row opens its detail in a dialog.
import { useMemo, useState } from "react";
import { requestOpenFeature } from "../../lib/featureRequest";
import { useT } from "../../lib/i18n";
import { usePersistedChoice, PREFS } from "../../lib/prefs";
import WorkspaceHistoryChanges from "./WorkspaceHistoryChanges";
import WorkspaceHistoryDeleted from "./WorkspaceHistoryDeleted";
import { SpaceFilterButton, SpaceFilterNote, usePhoneSpaceFilter } from "../SpaceFilter";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePhoneTopbarActions } from "../../lib/phoneTopbarActions";
import { HistorySpaceContext, useHistorySpaceChoice } from "./historySpace";
import { NARROW, TWO_COLUMN_MIN_WIDTH, type DetailSlot } from "./detailSlot";
import { useElementSize } from "../../hooks/useElementSize";
import { Tab, TabList, TabPanel } from "../ui";
import "./WorkspaceHistory.css";

type Props = {
  online: boolean;
  /** Open a note (where its history is not available yet). */
  onOpenNote: (noteId: string) => void;
  /** Open one note's own history on the given day. Defaults to opening the
   *  note with its history slider on the end of that day. */
  onOpenNoteHistory?: (noteId: string, day: string) => void;
  /** Open the inbox page, which lists the notes with paragraphs both sides changed. */
  onOpenInbox?: () => void;
};

const TABS = ["changes", "deleted"] as const;
type HistoryTab = (typeof TABS)[number];

export default function WorkspaceHistory({ online, onOpenNote, onOpenNoteHistory, onOpenInbox }: Props) {
  const t = useT();
  const openInbox = onOpenInbox ?? (() => requestOpenFeature("capture"));
  const [notice, setNotice] = useState<string | null>(null);
  const space = useHistorySpaceChoice(online);
  // A phone's space button is in the top bar (and a note shows while narrowed); a computer's is in the tab row.
  const phone = useIsMobile();
  const spaceFilter = { spaces: space.spaces, value: space.spaceId, onChange: space.setSpaceId, menuLabel: t("Show changes from one space") };
  const phoneSpace = usePhoneSpaceFilter(spaceFilter);
  usePhoneTopbarActions(phone && phoneSpace.action ? [phoneSpace.action] : []);
  const [tab, setTab] = usePersistedChoice<HistoryTab>(PREFS.historyTab, TABS, "changes");
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const wide = (useElementSize(frame)?.width ?? 0) >= TWO_COLUMN_MIN_WIDTH;
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null);
  const detail = useMemo<DetailSlot>(() => wide ? { wide, host: detailHost } : NARROW, [wide, detailHost]);
  const labels: Record<HistoryTab, string> = { changes: t("Changes"), deleted: t("Recently deleted") };

  const choose = (next: HistoryTab) => { setTab(next); setNotice(null); };

  return (
    <HistorySpaceContext.Provider value={space}>
    <div ref={setFrame} className="wh-frame">
      <div className={wide ? "wh-split" : "wh-single"}>
        <div className={wide ? "wh-pane wh-list-pane" : "wh-root"}>
          <div className="wh-head">
          <TabList className="wh-tabs" label={t("History")}>
            {TABS.map((id) => (
              <Tab
                key={id}
                id={`wh-tab-${id}`}
                selected={tab === id}
                controls={tab === id ? `wh-panel-${id}` : undefined}
                className={"wh-tab wh-touch" + (tab === id ? " active" : "")}
                onClick={() => choose(id)}
              >
                {labels[id]}
              </Tab>
            ))}
          </TabList>
          {!phone && space.spaces.length >= 2 && <SpaceFilterButton {...spaceFilter} />}
          </div>
          {phone && <>{phoneSpace.menu}<SpaceFilterNote {...spaceFilter} /></>}
          {notice && <p className="wh-notice" role="status">{notice}</p>}
          <TabPanel id={`wh-panel-${tab}`} labelledBy={`wh-tab-${tab}`} className="wh-panel">
            {tab === "changes" ? (
              <WorkspaceHistoryChanges
                online={online}
                onOpenNote={onOpenNote}
                onOpenNoteHistory={onOpenNoteHistory}
                onOpenInbox={openInbox}
                onNotice={setNotice}
                detail={detail}
              />
            ) : (
              <WorkspaceHistoryDeleted online={online} onNotice={setNotice} detail={detail} />
            )}
          </TabPanel>
        </div>
        {wide && <section ref={setDetailHost} className="wh-pane wh-detail-pane" aria-label={t("Version history")} />}
      </div>
    </div>
    </HistorySpaceContext.Provider>
  );
}
