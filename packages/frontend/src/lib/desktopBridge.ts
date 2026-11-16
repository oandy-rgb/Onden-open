// The desktop app's door for 「Answer with the AI on this computer」 (packages/desktop/src/aiAnswering/bridge.mjs).
// Only the desktop shell has `window.ondenDesktop`; in a normal browser `desktopAi()` is null and the page shows a
// guide instead of a button. The shell validates every argument; this file only types the calls. The connection code
// goes through `enableOwn`/`enableRemote` once and comes back nowhere.
import { useEffect, useState } from "react";

export type AnswerPhase = "stopped" | "waiting" | "answering" | "refused" | "unreachable";
type AnswerTarget = { enabled: boolean; phase: AnswerPhase; actorId?: string; codeId?: string; address?: string };
type AnswerStatus = { own: AnswerTarget; remote: AnswerTarget; canStoreSecurely: boolean };
/** Why the shell said no, as codes the page words (never shown raw). */
export type AnswerRefusal = "missing" | "not_logged_in" | "no_secure_storage" | "bad_address" | "bad_code" | "code_refused" | "unreachable" | "not_ready" | "unavailable";
export type AnswerResult = { ok: true } | { ok: false; reason: AnswerRefusal };

export type DesktopAi = {
  detect(): Promise<AnswerResult>;
  status(): Promise<AnswerStatus>;
  previewAddress(text: string): Promise<{ ok: true; address: string } | { ok: false }>;
  enableOwn(input: { actorId: string; code: string; codeId?: string }): Promise<AnswerResult>;
  disableOwn(): Promise<{ ok: true }>;
  enableRemote(input: { address: string; code: string }): Promise<AnswerResult>;
  disableRemote(): Promise<{ ok: true }>;
  onStatus(callback: (status: AnswerStatus) => void): () => void;
};

/** The shell's bridge, or null in a normal browser. */
export function desktopAi(): DesktopAi | null {
  const bridge = (window as unknown as { ondenDesktop?: { ai?: DesktopAi } }).ondenDesktop;
  return bridge?.ai ?? null;
}

/** The answering status, kept current while the page is open. Null until the first answer. */
export function useAnswerStatus(bridge: DesktopAi | null): { status: AnswerStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<AnswerStatus | null>(null);
  const refresh = async () => { if (bridge) setStatus(await bridge.status().catch(() => null)); };
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.status().then((s) => { if (live) setStatus(s); }).catch(() => {});
    const off = bridge.onStatus((s) => { if (live) setStatus(s); });
    return () => { live = false; off(); };
  }, [bridge]);
  return { status, refresh };
}
