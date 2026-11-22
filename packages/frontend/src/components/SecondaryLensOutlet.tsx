import { Suspense, type ReactNode } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { addToast, selectOverviewSelectedNode, useAppSelector, useOnline, useTagRows, useAllNodes } from "../lib/appStore";
import type { AppView } from "../hooks/useUrlLocation";
import type { useDueSoonNotifications } from "../hooks/useDueSoonNotifications";
import { useModuleFilter, useTasksEnabled } from "../hooks/useModuleFilter";
import { shellFeatureModule } from "../lib/shellFeatures";
import { GraphScreen, MODULE_SCREENS, READING_SECTIONS, TasksMode, readingSectionsFor, type ModuleTarget } from "../modules";
import ModuleNotImported from "./ModuleNotImported";
import RegionErrorBoundary from "./RegionErrorBoundary";

const TimelineLens = lazyWithReload(() => import("./TimelineLens"));
const ReadingScreen = lazyWithReload(() => import("./ReadingScreen"));

type Props = {
  mode: AppView;
  refresh: () => Promise<void>;
  /** Open a note in place (the mobile-safe chokepoint). */
  onOpenNote: (id: string) => void;
  /** From the agenda: remember where we were, open the host note in the editor. */
  onOpenNoteFromAgenda: (id: string) => void;
  dueSoon: ReturnType<typeof useDueSoonNotifications>;
  openModule: (id: string, target?: ModuleTarget) => void;
  moduleTarget: ModuleTarget | null;
  onImmersiveChange: (immersive: boolean) => void;
};

/** The center pane for every view except "notes" (which keeps its own
 *  three-column layout in BuilderApp): tasks, graph, timeline, module
 *  screens and the reading hub. Renders nothing for a view it does not own. */
export default function SecondaryLensOutlet({
  mode, refresh, onOpenNote, onOpenNoteFromAgenda,
  dueSoon, openModule, moduleTarget, onImmersiveChange,
}: Props) {
  const online = useOnline();
  const nodes = useAllNodes();
  const edges = useAppSelector((s) => s.data.edges);
  const tags = useTagRows();
  const overviewSelectedNode = useAppSelector(selectOverviewSelectedNode);
  const isModuleImported = useModuleFilter();
  const tasksOn = useTasksEnabled();
  const tasksModuleId = shellFeatureModule("tasks");

  // The same components/props as the old `mode === X ? … :` chain, data-driven
  // and sharing the lens list with the strip.
  const lenses: Partial<Record<AppView, () => ReactNode>> = {
    tasks: () => !tasksOn ? (
      <ModuleNotImported moduleId={tasksModuleId} />
    ) : (
      <Suspense fallback={<div className="lazy-loading-pane" />}>
        <TasksMode
          online={online}
          // Jumping from the agenda to a task's host note must land in the
          // EDITOR lens — a sticky non-editor lens hid the just-tapped task.
          onSelectNode={onOpenNoteFromAgenda}
          onRefresh={refresh}
          onError={(msg) => addToast(msg, "error")}
          reminderPermission={dueSoon.permission}
          onEnableReminders={dueSoon.requestPermission}
        />
      </Suspense>
    ),
    // Places "Graph" — what the Canvas "All Cards" tab used to show (it was
    // never a canvas). The whole workspace; a note's own links are the info panel's tab.
    graph: () => (
      <Suspense fallback={<div className="lazy-loading-pane u-fill" />}>
        <GraphScreen
          selectedNodeId={overviewSelectedNode?.id ?? null}
          nodes={nodes}
          edges={edges}
          tags={tags ?? []}
          onSelectNode={(id) => onOpenNote(id)}
        />
      </Suspense>
    ),
    // view=timeline: the History screen for the whole workspace. A note's own history is the
    // time slider, so there is no per-note version of this screen; old `?view=timeline` links,
    // the mobile nav slot and the palette all land here.
    timeline: () => (
      <Suspense fallback={<div className="lazy-loading-pane u-fill" />}>
        <TimelineLens online={online} onOpen={(id) => onOpenNote(id)} />
      </Suspense>
    ),
    // Module screens: each module's full page (`?view=<module id>`).
    // A module the workspace has not imported (an old link, history) points
    // at the module library instead of opening.
    ...Object.fromEntries([...MODULE_SCREENS].map(([id, { Component }]) => [id, () => !isModuleImported(id) ? (
      <ModuleNotImported moduleId={id} />
    ) : (
      <Suspense fallback={<div className="lazy-loading-pane u-fill" />}>
        <Component
          online={online}
          target={moduleTarget}
          onOpenNode={(nodeId) => onOpenNote(nodeId)}
          onOpenView={(id) => openModule(id)}
          onRefresh={refresh}
          onImmersiveChange={onImmersiveChange}
        />
      </Suspense>
    )])),
    // The reading hub (閱讀): one view per section (`?view=<section id>`),
    // all laid out by the same page with the imported modules' sections.
    ...Object.fromEntries(READING_SECTIONS.map(({ id, moduleId }) => [id, () => !isModuleImported(moduleId) ? (
      <ModuleNotImported moduleId={moduleId} />
    ) : (
      <Suspense fallback={<div className="lazy-loading-pane u-fill" />}>
        <ReadingScreen
          activeId={id}
          sections={readingSectionsFor(isModuleImported)}
          onSelect={(sectionId) => openModule(sectionId)}
          online={online}
          target={moduleTarget}
          onOpenNode={(nodeId) => onOpenNote(nodeId)}
          onRefresh={refresh}
          onImmersiveChange={onImmersiveChange}
        />
      </Suspense>
    )])),
  };

  // The one seam every module screen and the reading hub go through: a screen that throws is replaced by the
  // message in this pane only (the sidebar and the bars stay), and going to another page clears it.
  return <RegionErrorBoundary region={`lens:${mode}`} resetKeys={[mode, moduleTarget]}>{lenses[mode]?.() ?? null}</RegionErrorBoundary>;
}
