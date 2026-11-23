import { useEffect, useState, type ReactNode } from "react";
import { watchServerBuild } from "../lib/buildVersion";
import { useNewVersionAvailable } from "../lib/appStore";
import { useProtocolBlock } from "../lib/protocolGate";
import { reloadForNewVersion, reloadOnceForNewVersion } from "../lib/lazyWithReload";
import { useT } from "../lib/i18n";
import { Pressable } from "./ui";

/** How long a loading screen may go without moving on before it says so. */
const BOOT_STALL_MS = 12_000;

type BootState = "moving" | "updating" | "stalled" | "newVersion";

/** Every screen between opening the app and the workspace (session check, code download, first sync) is wrapped in
 *  this, so none of them can spin forever: it shows `children` while things move, then
 *  - a newer version is out (this page is too old for the server): reloads once by itself, or, when that already
 *    happened for this build, asks with a button;
 *  - nothing moved for BOOT_STALL_MS: says it takes longer than expected, with a reload button.
 *  Each screen that replaces another mounts its own watchdog, so the 12 seconds count from the last change of screen. */
export default function BootWatchdog({ children }: { children: ReactNode }) {
  const t = useT();
  const [stalled, setStalled] = useState(false);
  // The page only hears the server's build once a request went out; the workspace starts listening later (deviceStatus).
  useEffect(() => { watchServerBuild(); }, []);
  const protocolSaysOld = useProtocolBlock() === "page_old";
  const buildSaysOld = useNewVersionAvailable();
  const pageIsOld = protocolSaysOld || buildSaysOld;
  // undefined: not decided yet; true: reloading by itself; false: it already did once for this build (or could not).
  const [autoReload, setAutoReload] = useState<boolean | undefined>(undefined);
  const [reloadRefused, setReloadRefused] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), BOOT_STALL_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!pageIsOld) return;
    let live = true;
    void reloadOnceForNewVersion().catch(() => false).then((reloading) => { if (live) setAutoReload(reloading); });
    return () => { live = false; };
  }, [pageIsOld]);

  const state: BootState = pageIsOld ? (autoReload === false ? "newVersion" : "updating") : stalled ? "stalled" : "moving";
  if (state === "moving") return <>{children}</>;

  async function reload() {
    setReloadRefused(false);
    let safe = false;
    try { safe = (await reloadForNewVersion()).kind === "safe"; } catch { /* the line below says it */ }
    if (!safe) setReloadRefused(true);
  }

  const title = state === "updating" ? t("A new version is out. Reloading…")
    : state === "newVersion" ? t("A new version is out")
    : t("This is taking longer than expected");
  const note = state === "updating" ? t("Your notes stay as they are.")
    : state === "newVersion" ? t("Reload to continue with the new version.")
    : t("Reload the page to try again. Your notes stay as they are.");
  return (
    <div className="login-gate">
      <section className="login-card login-connection" aria-label={title} role="status">
        <div className="login-logo">Onden</div>
        <h1 className="login-connection-title">{title}</h1>
        <p className="login-connection-note">{reloadRefused ? t("Couldn't confirm your text is saved, so the page can't reload. Try again in a moment.") : note}</p>
        {state !== "updating" && <Pressable className="login-submit" type="button" onClick={() => void reload()}>{t("Reload page")}</Pressable>}
      </section>
    </div>
  );
}
