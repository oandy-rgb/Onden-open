// Capture (捕捉) — a built-in module (docs/agents/decisions-modules.md): quick
// capture and its inbox. Always available, so there is no `library` card, no
// switch and no "off" state, and Settings › Modules does not list it. The
// backend twin is backend/src/modules/capture (the inbox tag).
//
// What it gives the app:
//   • QuickCapture — the box the phone's ＋, ⌘⇧N and the palette open
//     (openQuickCapture); mounted once by the shell's overlays;
//   • the inbox page (`?view=capture`; the phone's 筆記 tab and the desktop sidebar's first row open it, it is not a nav destination) with a mark counting the
//     captures that wait; a capture with no place of its own is a top-level
//     note carrying the module's tag, kept out of the note tree (isPendingCapture,
//     lib/sidebarTidy);
//   • one setting, where a capture goes when no place is named, under
//     Settings › 快速記錄 (the account's, captureDestination).
// The words of a capture may name a tag, a note or a day (captureText.ts); the
// module also answers "what was jotted down that day" for the timeline
// (capturesOnDay).

import { Inbox } from "lucide-react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import type { BuiltInModule } from "../types";
const CaptureDestinationSetting = lazyWithReload(() => import("./CaptureDestinationSetting"));
import CaptureNavIndicator from "./CaptureNavIndicator";

export { default as QuickCapture } from "./QuickCaptureHost";
/** The capture box's file, for the offline warm-up (modules/index loadOfflineModuleScreens). */
export const loadQuickCapture = () => import("./QuickCapture");
export { openQuickCapture } from "./openQuickCapture";
export { isPendingCapture, pendingCaptures, capturesOnDay } from "./inbox";

export const captureModule: BuiltInModule = {
  id: "capture",
  appliesOwnTag: true,
  screen: { label: "Inbox", Icon: Inbox, Component: lazyWithReload(() => import("./InboxScreen")), inNav: false },
  NavIndicator: CaptureNavIndicator,
  settings: [{
    id: "capture.destination",
    // On its own page of Settings (快速記錄, with the other ways of writing); it is always on.
    tab: "capture",
    label: "Where captures go",
    keywords: ["capture", "inbox", "jot", "quick", "收件匣", "捕捉", "記一筆", "日記"],
    type: "custom",
    component: CaptureDestinationSetting,
  }],
};
