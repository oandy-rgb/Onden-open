import { useRef, useState } from "react";

import { addToast } from "../../lib/appStore";
import { desktopAi, useAnswerStatus, type AnswerPhase, type AnswerRefusal, type AnswerResult, type DesktopAi } from "../../lib/desktopBridge";
import { useT } from "../../lib/i18n";
import { randomUUID } from "../../lib/uuid";
import { Button, TextField } from "../../components/ui";
import { reads } from "../../lib/data";
import { createAiWithConnection, ensureAiModuleOn, giveCode, revokeCodeNow } from "./actions";
import type { AiRoleInfo } from "./aiRoleInfo";
import type { AiPageData } from "./model";
import "./strings";

// 「Answer with the AI on this computer」 (docs/architecture/proposals/desktop-ai-answering-2026-11-15.md). In the
// desktop app: one button per target, kept honest by what the shell and the server say. In a browser there is no
// shell, so only a sentence pointing at the guide. The connection code is made by the existing operations, handed to
// the shell once, and is never kept, shown or logged here.

export default function ThisComputerAnswering({ data, aiOn, online, onChanged }: {
  data: AiPageData; aiOn: boolean; online: boolean; onChanged: () => void;
}) {
  const bridge = desktopAi();
  // In a normal browser there is no shell to do this: the section is not shown at all.
  if (!bridge) return null;
  return <DesktopSection bridge={bridge} data={data} aiOn={aiOn} online={online} onChanged={onChanged} />;
}

function useRefusalText() {
  const t = useT();
  return (reason: AnswerRefusal): string => ({
    missing: t("No AI tool was found on this computer. Install one and sign in to it, then come back and turn this on."),
    not_logged_in: t("The AI tool on this computer is not signed in. Sign in to it in a terminal, then come back and turn this on."),
    no_secure_storage: t("This computer cannot keep the connection code safely (no system key store is available), so this stays off."),
    bad_address: t("That address cannot be used. It must start with https:// (http:// only works for this computer or your home network)."),
    code_refused: t("That server does not accept this connection code. Check that it is complete and has not been revoked."),
    unreachable: t("Could not reach that server. Check the address and your connection."),
    not_ready: t("The app is still starting. Try again in a moment."),
    bad_code: t("That connection code looks incomplete. Copy the whole code and try again."),
    unavailable: t("Answering with the AI on this computer is not available in this app right now."),
  })[reason];
}

function usePhaseText() {
  const t = useT();
  return (phase: AnswerPhase): string => {
    switch (phase) {
      case "waiting": return t("On. Questions are answered as they come in.");
      case "answering": return t("Answering a question now.");
      case "refused": return t("The server does not accept the connection code (it may have been revoked). Turn this off and on again.");
      case "unreachable": return t("Cannot reach the server. It will keep trying.");
      default: return t("Starting…");
    }
  };
}

function DesktopSection({ bridge, data, aiOn, online, onChanged }: {
  bridge: DesktopAi; data: AiPageData; aiOn: boolean; online: boolean; onChanged: () => void;
}) {
  const t = useT();
  const refusal = useRefusalText();
  const phaseText = usePhaseText();
  const { status } = useAnswerStatus(bridge);
  const [busy, setBusy] = useState<"own" | "remote" | null>(null);
  const [notice, setNotice] = useState<{ target: "own" | "remote"; text: string } | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [previewed, setPreviewed] = useState<string | null>(null);
  const writeKeys = useRef({ role: randomUUID(), code: randomUUID() });

  if (!status) return <section className="ai-area" aria-label={t("Answer with the AI on this computer")}><h3>{t("Answer with the AI on this computer")}</h3><p className="setting-note">{t("Loading…")}</p></section>;
  const say = (target: "own" | "remote", result: AnswerResult) => { if (!result.ok) setNotice({ target, text: refusal(result.reason) }); return result.ok; };

  /** The ids of an AI's live connection codes: before and after making one, the difference is the code this button made. */
  const codeIds = async (actorId: string) => (await reads.people.actorTokens<{ id: string; revoked_at: string | null }>(actorId).catch(() => [])).filter((k) => !k.revoked_at).map((k) => k.id);

  /** The AI this button made before: the one the shell remembers, or one by its name (a reply that was lost on the first try). */
  async function findMyAi(): Promise<AiRoleInfo | undefined> {
    const known = data.roles.find((r) => r.actor_id === status!.own.actorId);
    if (known) return known;
    const fresh = await reads.aiRuntime.roles<AiRoleInfo>().then((r) => r.roles, () => data.roles);
    return fresh.find((r) => r.name === t("AI on this computer"));
  }

  async function turnOnOwn() {
    setBusy("own"); setNotice(null);
    try {
      // Everything the shell can refuse comes first, so nothing is made on the server for a button that cannot work.
      const tool = await bridge.detect();
      if (!say("own", tool)) return;
      if (!status!.canStoreSecurely) { say("own", { ok: false, reason: "no_secure_storage" }); return; }
      await ensureAiModuleOn(aiOn, online);
      let mine = await findMyAi();
      let actorId: string | null = mine?.actor_id ?? null;
      const before = actorId ? await codeIds(actorId) : [];
      let token: string | null = null;
      if (mine) {
        token = await giveCode(mine.actor_id, t("This computer"), mine.default_runtime === "mcp", writeKeys.current.code);
        if (token === null) writeKeys.current.code = randomUUID(); // a lost reply cannot be replayed into a code: the next try makes a new one
      } else {
        const made = await createAiWithConnection({ name: t("AI on this computer"), connection: { kind: "mcp", key_name: t("This computer") } }, writeKeys.current.role);
        actorId = made?.actorId ?? null; token = made?.token ?? null;
        // The server already made it but the reply was lost (`deduped`): the next press finds that AI by name and gives it a code.
        if (made?.deduped) { writeKeys.current.role = randomUUID(); setNotice({ target: "own", text: t("The AI was made, but its connection code could not be shown. Press the button again to give it a new one.") }); }
      }
      if (!actorId || !token) { onChanged(); return; } // a failed write was already reported
      writeKeys.current = { role: randomUUID(), code: randomUUID() };
      const codeId = (await codeIds(actorId)).find((id) => !before.includes(id));
      const result = await bridge.enableOwn({ actorId, code: token, ...(codeId ? { codeId } : {}) });
      onChanged();
      if (!say("own", result)) setNotice({ target: "own", text: t("The AI was made but could not start. Its connection code is listed above; revoke it, then try again.") });
    } catch { setNotice({ target: "own", text: t("Something went wrong. Try again.") }); }
    finally { setBusy(null); }
  }

  async function turnOffOwn() {
    setBusy("own"); setNotice(null);
    try {
      const codeId = status!.own.codeId;
      await bridge.disableOwn(); // stops answering and forgets the code first
      // Then take away only the code this button made (another one the owner made for a second computer stays), with the same operation the card's 「Revoke」 uses.
      const mine = data.codes.find((c) => c.id === codeId);
      const revoked = mine ? await revokeCodeNow(mine) : false;
      if (!revoked) setNotice({ target: "own", text: t("It stopped here, but its connection code could not be revoked. Revoke it from the AI's card.") });
      onChanged();
    } catch { setNotice({ target: "own", text: t("Something went wrong. Try again.") }); }
    finally { setBusy(null); }
  }

  async function previewRemote() {
    setNotice(null);
    const result = await bridge.previewAddress(address);
    if (result.ok) setPreviewed(result.address);
    else { setPreviewed(null); say("remote", { ok: false, reason: "bad_address" }); }
  }

  async function turnOnRemote() {
    if (!previewed) return;
    setBusy("remote"); setNotice(null);
    try {
      const result = await bridge.enableRemote({ address: previewed, code: code.trim() });
      if (!say("remote", result)) return; // the input stays, so it can be fixed and tried again
      setCode(""); setAddress(""); setPreviewed(null);
      addToast(t("Turned on. This computer now answers for that server while the app is open."), "success");
    } catch { setNotice({ target: "remote", text: t("Something went wrong. Try again.") }); }
    finally { setBusy(null); }
  }

  async function turnOffRemote() {
    setBusy("remote"); setNotice(null);
    try { await bridge.disableRemote(); } finally { setBusy(null); }
  }

  const own = status.own, remote = status.remote;
  return (
    <section className="ai-area ai-computer" aria-label={t("Answer with the AI on this computer")}>
      <h3>{t("Answer with the AI on this computer")}</h3>
      <p className="setting-note">{t("Lets an AI tool that is already signed in on this computer answer questions in your notes. It uses your own AI subscription, so no API key is needed. It answers only while this app is open.")}</p>

      <div className="ai-card" data-target="own">
        <strong>{t("Notes in this app")}</strong>
        {own.enabled ? <p className="ai-card-line" role="status">{phaseText(own.phase)}</p> : <p className="ai-card-line">{t("Off")}</p>}
        <div className="ai-card-actions">
          {own.enabled
            ? <Button variant="secondary" size="sm" className="ai-touch" disabled={busy !== null} onClick={() => void turnOffOwn()}>{t("Turn off")}</Button>
            : <Button variant="primary" size="sm" className="ai-touch" disabled={!online || busy !== null} onClick={() => void turnOnOwn()}>{busy === "own" ? t("Turning on…") : t("Answer with the AI on this computer")}</Button>}
        </div>
        {notice?.target === "own" && <p className="ai-card-reason" role="alert">{notice.text}</p>}
      </div>

      <div className="ai-card" data-target="remote">
        <strong>{t("Another Onden server")}</strong>
        {remote.enabled ? (
          <>
            <p className="ai-card-line">{t("Answering for {address}", { address: remote.address ?? "" })}</p>
            <p className="ai-card-line" role="status">{phaseText(remote.phase)}</p>
            <p className="member-hint">{t("The connection code cannot be shown again. To stop it working altogether, revoke it on that server.")}</p>
            <div className="ai-card-actions">
              <Button variant="secondary" size="sm" className="ai-touch" disabled={busy !== null} onClick={() => void turnOffRemote()}>{t("Turn off")}</Button>
            </div>
          </>
        ) : (
          <form className="ai-flow" aria-label={t("Another Onden server")} onSubmit={(e) => { e.preventDefault(); void (previewed ? turnOnRemote() : previewRemote()); }}>
            <p className="member-hint">{t("This computer only answers; your notes stay on that server. On that server, make an AI with its own connection code, then paste the server's address and the code here.")}</p>
            <label htmlFor="ai-remote-address">{t("Server address")}</label>
            <TextField id="ai-remote-address" value={address} placeholder="https://" inputMode="url" autoComplete="off" disabled={busy !== null || previewed !== null}
              onChange={(e) => { setAddress(e.target.value); }} />
            <label htmlFor="ai-remote-code">{t("Connection code")}</label>
            <TextField id="ai-remote-code" type="password" value={code} autoComplete="off" disabled={busy !== null} onChange={(e) => setCode(e.target.value)} />
            {previewed && <p className="ai-card-line" role="status">{t("This computer will answer for: {address}. Is that right?", { address: previewed })}</p>}
            <div className="ai-flow-actions">
              {previewed && <Button variant="ghost" className="ai-touch" disabled={busy !== null} onClick={() => setPreviewed(null)}>{t("Change the address")}</Button>}
              <Button type="submit" variant="primary" className="ai-touch" disabled={!online || busy !== null || !address.trim() || !code.trim()}>
                {busy === "remote" ? t("Turning on…") : previewed ? t("Save and turn on") : t("Check the address")}
              </Button>
            </div>
          </form>
        )}
        {notice?.target === "remote" && <p className="ai-card-reason" role="alert">{notice.text}</p>}
      </div>
    </section>
  );
}
