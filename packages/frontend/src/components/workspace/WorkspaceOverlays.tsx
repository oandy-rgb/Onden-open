import { Suspense, useMemo, useState } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { addToast, useOnline, useTagRows, useAllNodes } from "../../lib/appStore";
import { useModuleFilter, useTasksEnabled } from "../../hooks/useModuleFilter";
import { createKindsFor } from "../../lib/createKinds";
import type { PaletteWiring } from "./PaletteHost";
import type { CreateFn } from "../../hooks/useNodeCreation";
import type { useSettingsDialog } from "../../hooks/useSettingsDialog";
import FailedWriteRecovery from "../FailedWriteRecovery";
import { FocusHost, QuickAddTask, QuickCapture, TaskSheetHost } from "../../modules";
import { useIncomingShare, type RawShare } from "../../lib/share";
import { loadShortcutsCheatsheet, loadTimeZoneAsk } from "../lateShell";
import ToastStack from "../ToastStack";
import { useTextStyleSheet } from "../../lib/textStyleRequest";

// Self-managed overlays nobody needs at first paint (components/lateShell.ts).
const ShortcutsCheatsheet = lazyWithReload(loadShortcutsCheatsheet);
const TimeZoneAsk = lazyWithReload(loadTimeZoneAsk);
const CreateSheet = lazyWithReload(() => import("../CreateSheet"));
const SettingsModal = lazyWithReload(() => import("../../settings/SettingsModal"));
const NoteTextStyleSheet = lazyWithReload(() => import("../../settings/NoteTextStyleSheet"));
// Not on the first screen: fetched when the palette first opens (and warmed for offline by lib/offlineWarmup.ts).
const PaletteHost = lazyWithReload(() => import("./PaletteHost"));

type Props = {
  palette: PaletteWiring;
  settings: ReturnType<typeof useSettingsDialog>;
  /** What a mobile share arrived with in the URL (GET Web Share Target); the
   *  POSTed and Android shares come from the share inbox. */
  sharedDraft: RawShare | null;
  /** The page was opened on `?capture=1`: the capture box opens, empty if nothing was shared. */
  openCapture: boolean;
  /** The shared create entry: quick capture's other kinds and its 「更多…」. */
  create: CreateFn;
  /** Open a tag's page (Settings › 模組 lists tags left by removed modules). */
  onOpenTag: (id: string) => void;
  /** Open a note (Settings › Skills lists the person's skill notes; the focus
   *  timer's 「到編輯器裡寫」). */
  onOpenNote: (id: string) => void;
  refresh: () => Promise<void>;
};

/** The shell's dialogs and floating layers, shown over every mode. */
export default function WorkspaceOverlays({ palette, settings, sharedDraft, openCapture, create, onOpenTag, onOpenNote, refresh }: Props) {
  const online = useOnline();
  const textStyle = useTextStyleSheet();
  const tasksOn = useTasksEnabled();
  const nodes = useAllNodes();
  const tags = useTagRows();
  const isImported = useModuleFilter();
  // Quick capture's other kinds (the icons by its box) are the create sheet's, and
  // its 「更多…」 is that sheet.
  const kinds = useMemo(() => createKindsFor(isImported), [isImported]);
  const [createSheet, setCreateSheet] = useState(false);
  // Once opened, the palette stays mounted (it keeps its closing state).
  const [paletteSeen, setPaletteSeen] = useState(false);
  if (palette.state.paletteOpen && !paletteSeen) setPaletteSeen(true);
  // 「分享 → Onden」: every share opens quick capture prefilled.
  const share = useIncomingShare(sharedDraft, online);
  return (
    <>
      {/* Toast notifications — self-subscribed overlay (H4) */}
      <ToastStack />

      {/* 旅行時詢問: the owner's device is in another time zone (a quiet card). */}
      <Suspense fallback={null}><TimeZoneAsk /></Suspense>

      {/* Keyboard cheatsheet — self-managed overlay; owns its open state via a
          window "?" listener (lib/shortcuts), so it just needs to be mounted. */}
      <Suspense fallback={null}><ShortcutsCheatsheet /></Suspense>

      {/* Persistent recovery for writes the offline queue couldn't persist —
          keeps the lost content visible + retryable instead of a toast that
          vanishes (data-loss trust on the mobile capture path). */}
      <FailedWriteRecovery />

      {paletteSeen && (
        <Suspense fallback={null}>
          <PaletteHost state={palette.state} options={palette.options} />
        </Suspense>
      )}

      <QuickCapture
        online={online}
        nodes={nodes}
        tags={tags ?? []}
        share={share}
        create={create}
        kinds={kinds}
        onMore={() => setCreateSheet(true)}
        onRefresh={refresh}
        initialDraft={openCapture ? "" : null}
      />
      {createSheet && <Suspense fallback={null}><CreateSheet create={create} request={{ kind: "note" }} presentation="sheet" onClose={() => setCreateSheet(false)} /></Suspense>}
      {tasksOn && <QuickAddTask />}
      <TaskSheetHost online={online} onSelectNode={onOpenNote} onRefresh={() => { void refresh(); }} onError={(message) => addToast(message, "error")} />
      <FocusHost onOpenNote={onOpenNote} />

      {textStyle.open && <Suspense fallback={null}><NoteTextStyleSheet trigger={textStyle.trigger} onClose={textStyle.close} /></Suspense>}
      {settings.open && (
        <Suspense fallback={null}>
          <SettingsModal
            key={settings.tab ?? "default"}
            initialTab={settings.tab}
            online={online}
            onClose={settings.closeSettings}
            onImportDone={() => { void refresh(); }}
            onConnect={settings.connected}
            onOpenTag={onOpenTag}
            onOpenNote={onOpenNote}
          />
        </Suspense>
      )}
    </>
  );
}
