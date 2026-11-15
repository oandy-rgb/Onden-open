import { useMemo, useState } from "react";
import { addToast, setSelectedId, useAllNodes } from "../lib/appStore";
import { openSettings } from "../lib/settingsRequest";
import { installTagPack } from "../lib/moduleLibrary";
import { hasOwnNotes } from "../lib/dayNode";
import { t } from "../lib/i18n";
import type { AppMode, NotesView } from "./useUiMode";
import { useModuleFilter } from "./useModuleFilter";
import { MODULES, SITE_MODULE, SITE_PUBLISHER } from "../modules";
import { useStableCallback } from "./useStableCallback";
import { PREFS } from "../lib/prefs";
import { useHintOnce } from "./useHintOnce";
import { sampleNotesWereMade } from "../lib/firstRunLanding";

/** The first-run welcome card: whether it shows, and its two opt-ins
 *  (a starter tag pack; building the intro website). */
export function useWelcomeBanner({ refresh, setMode, setNotesView }: {
  refresh: () => Promise<void>;
  setMode: (mode: AppMode) => void;
  setNotesView: (view: NotesView) => void;
}): {
  visible: boolean;
  /** The browser app's first open already has sample notes, so the full card stays away; the language choice still shows once. */
  languageOnly: boolean;
  dismiss: () => void;
  installStarterPack: (pack: unknown, label: string) => Promise<boolean>;
  buildIntroSite: () => Promise<string | null>;
} {
  const isModuleImported = useModuleFilter();
  // A one-time hello, dismissed for good once the user acts on it or closes
  // it (once per account, on every device).
  const { show: welcomeNew, markSeen: dismiss } = useHintOnce("welcome", PREFS.welcomeDismissed);
  // A workspace that already has notes is not new, whatever this browser
  // remembers (a new device or URL starts with empty storage).
  const nodes = useAllNodes();
  const workspaceHasNotes = useMemo(() => hasOwnNotes(nodes), [nodes]);

  // First-run opt-in: install ONE starter pack via the same install-gated route
  // the Settings ▸ Your Data widget uses (POST /api/tags/import). Non-clobbering
  // (adds an ordinary, deletable schema tag) and only ever runs on an explicit
  // click in the welcome card. Resolves true so the card can confirm.
  const installStarterPack = useStableCallback(async (pack: unknown, label: string): Promise<boolean> => {
    try {
      // Same install operation the Settings ▸ Your Data widget uses.
      await installTagPack(pack);
    } catch {
      return false; // installTagPack reported it
    }
    // Installed either way; a failed refresh only delays when the tag shows.
    try {
      await refresh();
      addToast(t("Added {label} — find it in the tag panel", { label }), "info");
    } catch {
      addToast(t("Added {label}. Refresh to see it in the tag panel.", { label }), "info");
    }
    return true;
  });

  // First-run opt-in: BUILD THE USER'S FIRST WEBSITE — the publishing loop
  // itself, self-demonstrating (the site IS Onden). The site module does the
  // work (its sitePublisher: pages in a space that publishes, then a real
  // Publish), and Home is focused once the site is out. The website module
  // must be imported (this never imports a module unasked); when it is
  // not, this says so and opens the library. Resolves the site URL, null on failure.
  // The card stays up while it runs and afterwards, though the workspace now
  // has notes, so its link to the site (or a retry after a failure) can show.
  const [siteStarted, setSiteStarted] = useState(false);
  const buildIntroSite = useStableCallback(async (): Promise<string | null> => {
    if (!SITE_MODULE || !SITE_PUBLISHER) return null;
    if (!isModuleImported(SITE_MODULE)) {
      addToast(t("Turn on “{name}” in Settings › Modules first.", { name: t(MODULES.find((m) => m.id === SITE_MODULE)?.library.title ?? SITE_MODULE) }), "info");
      openSettings("modules");
      return null;
    }
    setSiteStarted(true);
    const site = await SITE_PUBLISHER.buildIntroSite();
    if (!site) return null;
    // The pages are made; the publish waits for the Website screen's own preview.
    if ("needsReview" in site) { setMode(SITE_MODULE); return null; }
    setSelectedId(site.homeId); setMode("notes"); setNotesView("editor");
    return site.url;
  });

  const visible = welcomeNew && (!workspaceHasNotes || siteStarted);
  const languageOnly = welcomeNew && !visible && sampleNotesWereMade();
  return { visible, languageOnly, dismiss, installStarterPack, buildIntroSite };
}
