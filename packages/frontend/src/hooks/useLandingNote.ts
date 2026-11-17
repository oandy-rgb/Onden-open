import { useEffect, useRef, useState } from "react";
import { setSelectedId, useAppSelector, useSelectedId } from "../lib/appStore";
import { dailyNotesEnabled, findDayNode } from "../lib/dayNode";
import { getLaunchPreference } from "../lib/launchPreference";
import { landingHistory, navigate, parseLocation, type AppLocation } from "./useUrlLocation";
import { PREFS, getPref } from "../lib/prefs";
import { consumeFirstRunLanding, useFirstRunLanding } from "../lib/firstRunLanding";
import type { useUiMode } from "./useUiMode";
import type { ContentNode } from "../lib/api";
import { nodeOf } from "../lib/nodeIndex";

/** A note that exists and is not hidden (the landing targets must be openable). */
function isVisibleNote(data: { nodes: ContentNode[] }, id: string): boolean {
  const node = nodeOf(data, id);
  return !!node && !node.hidden;
}

type Options = {
  /** The URL's location at boot (useUrlLocation.readLocation). */
  initialLocation: AppLocation;
  ui: Pick<ReturnType<typeof useUiMode>, "setMode" | "setNotesView" | "setOverviewMobileTab">;
  openNote: (id: string) => void;
  /** Opens (or creates) today's note; resolves to its id. */
  openDailyNote: (options?: { announce?: boolean }) => Promise<string | null>;
};

/**
 * Where the workspace lands once it has loaded: a deep link wins, otherwise
 * the user's launch setting (today / home / resume-last).
 *
 * Call it in the first render: it captures the PREVIOUS session's last
 * location before useUrlSync's effects overwrite the stored one.
 */
export function useLandingNote({ initialLocation, ui, openNote, openDailyNote }: Options) {
  const { setMode, setNotesView, setOverviewMobileTab } = ui;
  const bootstrapped = useAppSelector((s) => s.bootstrapped);
  const membershipGated = useAppSelector((s) => s.membershipGated);
  const data = useAppSelector((s) => s.data);
  const selectedId = useSelectedId();
  const firstRun = useFirstRunLanding();

  // D5 resume-last: capture the PREVIOUS session's last location at first
  // render — useUrlSync mirrors every location to PREFS.lastLocation, so by the time
  // the launch effect runs, THIS boot's (node-less) location has already
  // overwritten the stored one. A state initializer runs before any effect.
  const [savedLastLocation] = useState(() => getPref(PREFS.lastLocation));

  const initializedRef = useRef(false);
  useEffect(() => {
    // A cached bootstrap may still contain a deleted/revoked landing target.
    // Wait for the existing membership gate before committing the one-shot pick.
    if (!bootstrapped || membershipGated || initializedRef.current) return;
    if (data.nodes.length === 0) return;
    // A brand-new workspace is still getting its example notes: land once they are in, not on
    // an empty journal page made in the meantime.
    if (firstRun.phase === "seeding") return;
    initializedRef.current = true;
    // A node from the URL (?node=) already seeded selectedId — don't override it
    // with the default pick (surface S2a deep-link). D5's non-clobbering rule:
    // the landing is additive, a deep link always wins.
    if (selectedId) return;
    // A PLACE deep link (?view=tasks/website/timeline) is exactly as explicit
    // as ?node= — landing must not clobber it either. (It used to: a cold
    // load on a place URL bounced to the landing note.)
    if (initialLocation.view !== "notes") return;
    // The first launch of a workspace that came with example notes opens the first one (the
    // welcome). Only this once: it is consumed here, so the 「打開時」 setting rules after.
    if (firstRun.phase === "done") {
      const welcomeId = firstRun.welcomeNoteId;
      consumeFirstRunLanding();
      if (welcomeId && isVisibleNote(data, welcomeId)) {
        openNote(welcomeId);
        setOverviewMobileTab("edit");
        return;
      }
    }
    // D5 — the landing is a per-user SETTING (today / home / resume-last),
    // journal-first by default (#25 capture-first startup, note-use-cases).
    // Resolve an existing daily note from the reconciled projection, including
    // durable local creations. A missing note uses the normal queued writer.
    const landing = getLaunchPreference();
    // The landing is the app choosing where to open, not a page the user went to: it takes the
    // first entry's place. Resuming is the exception — the page left earlier sits above the default
    // screen — and so is a phone, whose first entry is the notes list (the bottom of the notes stack).
    const land = (go: () => void) => navigate(go, { history: landingHistory(landing === "resume") });
    if (landing === "home") {
      const homeId = data.workspace.home_node_id;
      if (homeId && isVisibleNote(data, homeId)) {
        land(() => openNote(homeId));
        return;
      }
      // no home set / not visible → fall through to today
    }
    if (landing === "resume") {
      if (savedLastLocation) {
        const loc = parseLocation(savedLastLocation, { view: "notes", nodeId: null, lens: "editor" });
        if (nodeOf(data, loc.nodeId)) {
          land(() => {
            setSelectedId(loc.nodeId);
            setNotesView(loc.lens);
            setMode(loc.view);
            if (loc.view === "notes") setOverviewMobileTab("edit");
          });
          return;
        }
        if (loc.view !== "notes") { setMode(loc.view); return; }
      }
      // nothing to resume → fall through to today
    }
    // Daily notes off (日記 not imported): no today's note to land on, and
    // none is started — the home note when there is one, else the notes
    // screen as it is.
    if (!dailyNotesEnabled()) {
      const homeId = data.workspace.home_node_id;
      if (homeId && isVisibleNote(data, homeId)) land(() => openNote(homeId));
      return;
    }
    const existingToday = findDayNode(data.nodes);
    if (existingToday) {
      land(() => openNote(existingToday.id));
      return;
    }
    void openDailyNote({ announce: false }).then(id => { if (id) setOverviewMobileTab("edit"); });
  }, [bootstrapped, membershipGated, data.nodes, data.workspace.home_node_id, firstRun.phase]); // eslint-disable-line react-hooks/exhaustive-deps -- setSelectedId is stable; effect intentionally keyed on node-set changes

  // Two-axis nav (mobile-nav-two-axis): an explicit ?node= deep-link OPENS that
  // note — drill straight into the editor rather than the browse list (a shared/
  // linked note should land on its content). Automatic landing opens its own
  // target after bootstrap; explicit links use the original location here.
  useEffect(() => {
    if (initialLocation.nodeId) {
      setOverviewMobileTab("edit");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only deep-link drill
}
