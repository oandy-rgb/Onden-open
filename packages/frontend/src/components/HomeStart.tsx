import { useMemo } from "react";
import { CalendarDays, Hash, ListTodo, Clock3, Flame } from "lucide-react";
import type { ContentNode, NodeTask, Tag } from "../lib/api";
import { importedModules, type ModuleTarget } from "../modules";
import { useDailyNotesEnabled, useModuleFilter } from "../hooks/useModuleFilter";
import { useT, tn } from "../lib/i18n";
import { dayNoteDate } from "@onden/markdown";
import { MOODS, MOOD_ATTR_KEY, computeDayStreak, isMoodValue } from "../lib/moodStreak";
import "./HomeStart.css";
import { relTime } from "../lib/timeLabels";
import { recentNotes } from "../lib/recentNotes";
import { useToday } from "../hooks/useToday";
import { Button, Pressable } from "./ui";

// D5 — the home node's AUTO content. The home page is a real, authorable node
// (workspace.home_node_id), but its value can't depend on hand-maintained
// dashboards (they rot): this strip surfaces what's already true — today,
// recent work, pinned tags, loose ends — above the node's own markdown (the
// optional hand-authored MOC). Renders nothing it can't fill.

type Props = {
  homeNodeId: string;
  nodes: ContentNode[];
  tasks: NodeTask[];
  pinnedTags: Tag[];
  onOpenNode: (id: string) => void;
  onOpenToday: () => void;
  onOpenTagView: (tagId: string) => void;
  /** Open a module screen. Optional so the strip renders standalone (tests,
   *  future hosts) without module sections. */
  onOpenModule?: (id: string, target?: ModuleTarget) => void;
  /** Visible workspace tags (module sections read their tag functions). */
  allTags?: Tag[];
  /** Daily-journal delighter: set today's mood. Opens-or-creates today's note
   *  then writes the `mood` attribute (routed through the spine attribute
   *  mutation by the host). Optional so the strip renders standalone in tests. */
  onSetTodayMood?: (mood: string) => void;
};

export default function HomeStart({ homeNodeId, nodes, tasks, pinnedTags, onOpenNode, onOpenToday, onOpenTagView, onOpenModule, allTags = [], onSetTodayMood }: Props) {
  const t = useT();
  const isImported = useModuleFilter();
  // Daily notes (日記) off: no Today button, streak or mood picker.
  const dailyOn = useDailyNotesEnabled();
  // Daily-journal delighters: the "don't break the chain" streak (computed from
  // which calendar days already have a day note) and today's mood (an ordinary
  // `mood` node_attribute on today's day note). Both reuse the day-node flow —
  // no schema migration. Recomputes only when the node set changes.
  const today = useToday();
  const { streak, todayMood } = useMemo(() => ({
    streak: computeDayStreak(nodes),
    todayMood: nodes.find((n) => dayNoteDate(n) === today)?.attrs?.[MOOD_ATTR_KEY] ?? null,
  }), [nodes, today]);
  const recent = useMemo(() => recentNotes(nodes, homeNodeId, 5), [nodes, homeNodeId]);

  const looseEnds = useMemo(() => {
    const titleOf = new Map(nodes.map((n) => [n.id, n.title]));
    return tasks
      .filter((t) => t.status === "todo")
      .slice(-5)
      .reverse()
      .map((t) => ({ ...t, nodeTitle: t.node_id ? titleOf.get(t.node_id) : undefined }));
  }, [tasks, nodes]);

  return (
    <div className="home-start">
      <div className="home-start-row">
        {dailyOn && <Pressable className="home-start-today" onClick={onOpenToday}>
          <CalendarDays size={14} /> {t("Open today's note")}
        </Pressable>}
        {dailyOn && streak > 0 && (
          <span className="home-start-streak" title={t("Consecutive days with a note")}>
            <Flame size={13} /> {streak}
            <span className="home-start-streak-unit">{tn("day", "days", streak)}</span>
          </span>
        )}
        {dailyOn && onSetTodayMood && (
          <span className="home-start-mood" role="group" aria-label={t("Today's mood")}>
            {MOODS.map((m) => (
              <Pressable
                key={m.value}
                type="button"
                className={`home-start-mood-btn${isMoodValue(todayMood) && todayMood === m.value ? " is-active" : ""}`}
                title={t(m.label)}
                aria-label={t(m.label)}
                aria-pressed={todayMood === m.value}
                onClick={() => onSetTodayMood(m.value)}
              >
                {m.value}
              </Pressable>
            ))}
          </span>
        )}
        {pinnedTags.map((t) => (
          <Pressable
            key={t.id}
            className="home-start-tag"
            style={t.color ? ({ "--pin-color": t.color } as React.CSSProperties) : undefined}
            onClick={() => onOpenTagView(t.id)}
          >
            <Hash size={11} />{t.name}
          </Pressable>
        ))}
      </div>

      {recent.length > 0 && (
        <div className="home-start-section">
          <span className="home-start-label"><Clock3 size={11} /> {t("Recent")}</span>
          <ul className="home-start-list">
            {recent.map((n) => (
              <li key={n.id}>
                <Button onClick={() => onOpenNode(n.id)}>
                  {n.title || t("Untitled")}
                  <span className="home-start-time">{relTime(n.updated_at)}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Module sections ("To read", due cards, unread articles) render
          nothing when they have nothing to say. */}
      {onOpenModule && importedModules(isImported).map(({ id, HomeSection }) => HomeSection && (
        <HomeSection key={id} open={(target) => onOpenModule(id, target)}
          homeNodeId={homeNodeId} nodes={nodes} tags={allTags} onOpenNode={onOpenNode} />
      ))}

      {looseEnds.length > 0 && (
        <div className="home-start-section">
          <span className="home-start-label"><ListTodo size={11} /> {t("Loose ends")}</span>
          <ul className="home-start-list">
            {looseEnds.map((task) => (
              <li key={task.id}>
                <Button onClick={() => { if (task.node_id) onOpenNode(task.node_id); }}>
                  {task.title}
                  {task.nodeTitle && <span className="home-start-time">{task.nodeTitle}</span>}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
