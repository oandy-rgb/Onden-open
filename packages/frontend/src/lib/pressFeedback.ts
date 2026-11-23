// Answers for presses whose result takes a while or leaves the page (publishing, a download): the person must
// never face a silent screen. One notice says it is working, then becomes the answer in place (appStore
// `startWorking`); the screens below use these instead of each writing their own wait text.
import { startWorking, type WorkingNotice } from "./appStore";
import { t } from "./i18n";
import { timeLabel } from "./timeLabels";

/** Opens an address the person asked for in a new tab (a published site). */
function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** The site went out: when, and a way to look at it (the notice that said "publishing" becomes this). */
export function publishedAnswer(notice: WorkingNotice, url: string): void {
  notice.done(t("Published at {time}.", { time: timeLabel(new Date().toISOString()) }), { label: t("Open the site"), onClick: () => openInNewTab(url) });
}

/** The words for a file that was saved to this device. */
export const savedMessage = (name: string): string => t("Downloaded \"{name}\". Keep the file somewhere safe.", { name });

/** How long the "preparing" notice of a download the browser makes itself stays: the page cannot see when the browser
 *  gets its first byte (a backup takes about a minute), so the notice says what to expect and leaves by itself. */
export const DOWNLOAD_PREPARING_MS = 120_000;

/** For a link the browser downloads straight to disk (a full backup is never read into memory, so its size has no limit
 *  here). Says that the server is preparing the file and where the download will show up. */
export function announceDownloadPreparing(message: string): void {
  const notice = startWorking(message);
  setTimeout(() => notice.dismiss(), DOWNLOAD_PREPARING_MS);
}
