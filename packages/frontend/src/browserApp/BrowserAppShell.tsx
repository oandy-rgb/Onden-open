import { Suspense, useEffect, useState } from "react";
import { BROWSER_APP_LANG_PARAM, BROWSER_APP_LOCK, BROWSER_APP_TEMP_PARAM } from "@onden/markdown";
import { DEVICE_FILE_EMPTY_PARAM } from "@onden/markdown/contract";
import { systemLanguageTag } from "../lib/i18n";
import { Button } from "../components/ui";
import { lazyWithReload } from "../lib/lazyWithReload";
import { documentBaseUrl } from "../lib/documentAccess";
import { onPageHide } from "../lib/pageHide";
import { isTemporarySession } from "../lib/temporarySession";
import { readUrlParams, reopenWithQuery } from "../lib/pageUrl";
import { needsStartChoice } from "./startChoice";
import { readBringState, writeBringState } from "./bringNotes";
import { reloadPage } from "../lib/api";
import { holdTabLock } from "../lib/webLock";
import { beginFirstRunLanding, finishFirstRunLanding, markSampleNotesMade } from "../lib/firstRunLanding";
import { installFetchBridge } from "../lib/browserAppBridge";
import { declareLocalOnlyHost } from "../lib/localOnlyStatus";
import { answerMediaRequests, registerMediaServiceWorker, waitForMediaServing, type MediaServing } from "../lib/browserAppMedia";
import { startWorkerClient, WorkerStartFailure, type WorkerClient } from "../lib/browserAppWorker";
import { downloadBlob } from "../lib/download";
import { notesWereLost } from "../lib/browserAppDataMark";
import { requestPersistentStorage } from "../lib/storagePersist";
import { startingText } from "./startingText";
import { watchNewBuild } from "./watchNewBuild";
import "./BrowserAppShell.css";

// The browser app's page: take the one-tab lock, start the worker, bridge /api to it, then mount the normal app.
// Everything is plain words on this screen — it appears before the app's own dictionary and theme are loaded.

const AppRoot = lazyWithReload(() => import("../AppRoot"));
const TrialNotice = lazyWithReload(() => import("./TrialNotice"));
const TemporaryNotice = lazyWithReload(() => import("./TemporaryNotice"));
const StartChoice = lazyWithReload(() => import("./StartChoice"));
// Taking a file from another device: loaded only when the person chose it (browserApp/bringNotes.ts).
const BringNotes = lazyWithReload(() => import("./BringNotes"));
/** Built with `--start-choice` (scripts/build-browser.mjs): a first visit starts on a choice (browserApp/startChoice.ts). */
const START_CHOICE = import.meta.env.VITE_BROWSER_START_CHOICE === "true";

type Phase =
  | { kind: "starting"; replay: { done: number; total: number } | null }
  | { kind: "choose"; use: () => void; temporary: () => void; bring: () => void }
  /** An empty copy waiting for a file from another device; the app is not mounted (nothing writes) until the person leaves this. */
  | { kind: "bring"; client: WorkerClient; interrupted: boolean; leave: () => void }
  | { kind: "other-tab" }
  | { kind: "failed"; reason: "newer-copy" | "upgrade-failed" | "other"; client: WorkerClient }
  | { kind: "ready"; client: WorkerClient; recovered: number; upgraded: number; media: MediaServing; notesLost: boolean };

export default function BrowserAppShell() {
  const [phase, setPhase] = useState<Phase>({ kind: "starting", replay: null });

  useEffect(() => {
    let cancelled = false;
    let stopWatching: (() => void) | undefined;
    let stopAnswering: (() => void) | undefined;
    void (async () => {
      const temporary = isTemporarySession();
      if (needsStartChoice({ enabled: START_CHOICE, temporary, askedForApp: readUrlParams().get("app") === "1", hadNotes: START_CHOICE && !temporary && await notesWereLost() })) {
        await new Promise<void>((proceed) => {
          if (!cancelled) setPhase({ kind: "choose", use: proceed, temporary: () => reopenWithQuery(`?${BROWSER_APP_TEMP_PARAM}=1`), bring: () => { writeBringState("pending"); proceed(); } });
        });
        if (cancelled) return;
        setPhase({ kind: "starting", replay: null });
      }
      // A temporary session shares nothing with an ordinary one (no saved copy, no journal), so it neither needs the
      // one-tab lock nor may be kept out by an ordinary tab holding it.
      if (!temporary && !(await holdTabLock(BROWSER_APP_LOCK))) { if (!cancelled) setPhase({ kind: "other-tab" }); return; }
      // Waiting for (or half way through) a file from another device: this start is on an empty copy, without the samples.
      const bringState = temporary ? null : readBringState();
      const workerUrl = new URL("worker.js", documentBaseUrl());
      if (bringState) workerUrl.searchParams.set(DEVICE_FILE_EMPTY_PARAM, "1");
      const store = readUrlParams().get("store");
      if (temporary) { workerUrl.searchParams.set(BROWSER_APP_TEMP_PARAM, "1"); workerUrl.searchParams.set(BROWSER_APP_LANG_PARAM, systemLanguageTag()); }
      else if (store) workerUrl.searchParams.set("store", store); // ?store=indexeddb: take the Safari path on any browser (e2e)
      // Installed while the worker starts: the first picture already needs it (lib/browserAppMedia.ts).
      const mediaWorker = registerMediaServiceWorker();
      const client = startWorkerClient(workerUrl, (done, total) => { if (!cancelled) setPhase({ kind: "starting", replay: { done, total } }); });
      let info: Awaited<WorkerClient["ready"]>;
      try {
        info = await client.ready;
        // Read by e2e/browser-app/measure.mjs; the one place the start-up cost is told.
        console.info(`[browser-app] worker ready in ${info.bootMs} ms (${info.firstOpen ? "first open, packaged database" : "saved copy"}; saved in ${info.store}; upgraded ${info.upgraded}, recovered ${info.recovered})`);
        // The first open made sample notes: the app lands on the welcome one, not an empty journal page.
        if (info.welcomeNoteId) { beginFirstRunLanding(); finishFirstRunLanding(info.welcomeNoteId); if (info.firstOpen && !info.temporary) markSampleNotesMade(); }
      } catch (error) {
        console.warn(`[browser-app] the start failed: ${error instanceof Error ? error.message : String(error)}`); // for whoever reads the console; the page says it in words
        if (!cancelled) setPhase({ kind: "failed", reason: error instanceof WorkerStartFailure ? error.kind : "other", client });
        return;
      }
      // Started from the packaged database although this browser kept notes before: they went away (lib/browserAppDataMark.ts).
      const notesLost = !temporary && info.firstOpen && await notesWereLost();
      installFetchBridge(client);
      // Before the app mounts: no accounts, members or membership gate here (lib/hostCapabilities.ts).
      declareLocalOnlyHost();
      stopAnswering = answerMediaRequests(client);
      const media = await waitForMediaServing(mediaWorker);
      if (media === "reloading") return; // one ordinary reload hands the page to the Service Worker
      // Ask the browser to keep this site's data under storage pressure (the answer is shown in the trial dialog).
      // Nothing is kept in a temporary session: no request to keep it, no reload for a newer build (it would lose the writing).
      if (!temporary) {
        void requestPersistentStorage();
        // Not while a file is being taken in: a reload for a newer build would cut it off.
        if (!bringState) stopWatching = watchNewBuild();
        // Save before the page goes away or is hidden (a phone may kill the page without a second chance).
        onPageHide(() => { void client.flush(); });
      }
      const ready: Phase = { kind: "ready", client, recovered: info.recovered, upgraded: info.upgraded, media, notesLost };
      if (!cancelled) setPhase(bringState ? { kind: "bring", client, interrupted: bringState === "joining", leave: () => { stopWatching = watchNewBuild(); setPhase(ready); } } : ready);
    })();
    return () => { cancelled = true; stopWatching?.(); stopAnswering?.(); };
  }, []);

  if (phase.kind === "ready") {
    return (
      <>
        <Suspense fallback={null}><AppRoot /></Suspense>
        <Suspense fallback={null}>
          {isTemporarySession()
            ? <TemporaryNotice client={phase.client} media={phase.media} />
            : <TrialNotice client={phase.client} recovered={phase.recovered} upgraded={phase.upgraded} media={phase.media} notesLost={phase.notesLost} />}
        </Suspense>
      </>
    );
  }
  return (
    <>
    {phase.kind === "choose" && <Suspense fallback={null}><StartChoice onUse={phase.use} onTemporary={phase.temporary} onBring={phase.bring} /></Suspense>}
    {phase.kind === "bring" && <Suspense fallback={null}><BringNotes client={phase.client} interrupted={phase.interrupted} onLeave={phase.leave} /></Suspense>}
    {phase.kind !== "choose" && phase.kind !== "bring" && <main className="browser-app-status">
      {phase.kind === "starting" && <p>{startingText(phase.replay)}</p>}
      {phase.kind === "other-tab" && (
        <>
          <h1>已在另一個分頁開啟</h1>
          <p>試用版的資料只存在這個瀏覽器，同一時間只能在一個分頁使用，否則兩邊的修改會互相蓋掉。請回到那個分頁，或關掉它再重新整理這一頁。</p>
        </>
      )}
      {phase.kind === "failed" && <StartFailure reason={phase.reason} client={phase.client} />}
    </main>}
    </>
  );
}

/** The start failed: say which of the three it is, and offer the way out that loses nothing. */
function StartFailure({ reason, client }: { reason: "newer-copy" | "upgrade-failed" | "other"; client: WorkerClient }) {
  const [missing, setMissing] = useState(false);
  async function saveOldCopy() {
    const copy = await client.exportCopy();
    if (!copy) { setMissing(true); return; }
    downloadBlob(copy, "onden-old-data.tar");
  }
  return (
    <>
      {reason === "newer-copy" && (
        <>
          <h1>這份資料比這個版本新</h1>
          <p>這個瀏覽器裡的資料是用比目前更新的版本存的。為了不弄壞它，這個版本不會打開它，也沒有動過任何資料。請重新整理載入最新版；如果還是這樣，請用原本存資料的那一版網址開啟。</p>
        </>
      )}
      {reason === "upgrade-failed" && (
        <>
          <h1>資料升級沒有成功</h1>
          <p>新版需要先把你的資料升級，但這次沒有成功。你的舊資料原封不動地留在這個瀏覽器裡，可以先下載一份留著，再重新整理試一次。</p>
        </>
      )}
      {reason === "other" && (
        <>
          <h1>試用版打不開</h1>
          <p>這個瀏覽器沒辦法開啟試用版（可能是無痕視窗、儲存空間已滿，或瀏覽器太舊）。你的資料沒有被動到。</p>
        </>
      )}
      <div className="browser-app-status-actions">
        <Button type="button" onClick={reloadPage}>重新整理</Button>
        {reason !== "other" && <Button type="button" variant="secondary" onClick={() => void saveOldCopy()}>下載舊資料</Button>}
      </div>
      {missing && <p>找不到可以下載的舊資料。</p>}
    </>
  );
}
