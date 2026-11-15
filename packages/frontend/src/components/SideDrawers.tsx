import { GitBranch } from "lucide-react";
import { memo } from "react";
import type { DomainEvent } from "../lib/api";

import "./TagsPanel.css";
import "./SideDrawers.css";
import "./OverviewEditor.css";
import { classNames } from "../lib/utils";
import { useT } from "../lib/i18n";
import { dateLabel } from "../lib/timeLabels";
import { actorTypeLabel } from "./EventLogLabels";
import { eventTypeLabel } from "../lib/eventKinds";
import { Button } from "./ui";

const EventList = memo(function EventList({ events }: { events: DomainEvent[] }) {
  useT();
  return (
    <div className="event-list">
      {events.map((item) => (
        <div className="event-item" key={item.id}>
          <strong>{eventTypeLabel(item.event_type)}</strong>
          <span>{actorTypeLabel(item.actor_type)}</span>
          <time>{dateLabel(item.created_at, "shortDateTime")}</time>
        </div>
      ))}
    </div>
  );
});

type Props = {
  eventsOpen: boolean;
  onCloseEvents: () => void;
  mobileView: string;
  events: DomainEvent[];
};

export default function SideDrawers({
  eventsOpen, onCloseEvents, mobileView, events,
}: Props) {
  const t = useT();
  return (
    <>
      <aside className={classNames("panel event-drawer", !eventsOpen && "collapsed", mobileView !== "events" && "mobile-hidden")}>
        <div className="panel-header compact">
          <GitBranch size={16} />
          <h2>{t("Event Log")}</h2>
          <Button variant="ghost" className="push-right" onClick={onCloseEvents}>{t("Close")}</Button>
        </div>
        {/* Only an open drawer lists events: this component re-renders on
            every note switch, and formatting thousands of hidden rows cost
            ~20 ms per switch at 5,000 notes. */}
        {(eventsOpen || mobileView === "events") && <EventList events={events} />}
      </aside>
    </>
  );
}
