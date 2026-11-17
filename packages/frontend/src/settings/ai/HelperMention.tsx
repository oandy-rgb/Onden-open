import { useCallback, useEffect, useId, useState } from "react";

import { addToast } from "../../lib/appStore";
import { aiRoleWriter, reads, writeErrors } from "../../lib/data";
import { t, useT } from "../../lib/i18n";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Button, TextField } from "../../components/ui";

export type Runner = { actor_id: string; handle: string; enabled: boolean };

/** Whether an AI role can be asked from a note with `@ai` (or its own @name):
 *  undefined = not loaded or not the owner, null = never set up. */
export function useMentionRunner(actorId: string) {
  const [runner, setRunner] = useState<Runner | null | undefined>(undefined);
  const load = useCallback(async () => {
    try { setRunner((await reads.agentMentions.runners<Runner>()).runners.find((r) => r.actor_id === actorId) ?? null); }
    catch { setRunner(undefined); }
  }, [actorId]);
  useEffect(() => { void load(); }, [load]);
  return { runner, reload: load };
}

/** Turn `@ai` on or off for a role. Off cancels what it was asked and stops its
 *  running requests, so it is the 「暫停」 of this way of running; nothing is deleted. */
export async function setMentionEnabled(person: { id: string }, enabled: boolean, handle?: string): Promise<boolean> {
  try {
    if (handle !== undefined) await aiRoleWriter.setMentionName(person.id, handle);
    await aiRoleWriter.setMentionEnabled(person.id, enabled);
    return true;
  } catch (error) { writeErrors.report(error, addToast); return false; }
}

/** Pause an AI (after asking) or resume it. Answers whether the state changed. Pausing cancels what it is working on; nothing is deleted. */
export async function toggleMention(ai: { id: string; name: string }, runner: Runner): Promise<boolean> {
  if (runner.enabled && !(await confirmDialog(t("Pause @ mentions for {name}? Requests it is working on stop; nothing is deleted and you can resume any time.", { name: ai.name }), { confirmLabel: t("Pause") }))) return false;
  return setMentionEnabled(ai, !runner.enabled);
}

/** The @name field and the button that first turns `@ai` on; once it exists the
 *  card's pause / resume takes over. */
export function MentionSetup({ person, runner, online, onChanged }: {
  person: { id: string; name: string }; runner: Runner | null | undefined; online: boolean; onChanged: () => void;
}) {
  const t = useT();
  const nameId = useId();
  const [handle, setHandle] = useState("ai");
  const [busy, setBusy] = useState(false);
  if (runner === undefined) return null; // not the owner, or not loaded: nothing to offer
  async function turnOn() {
    if (busy) return;
    setBusy(true);
    const ok = await setMentionEnabled(person, true, runner ? undefined : handle.trim().toLowerCase());
    setBusy(false);
    if (ok) { addToast(t("@ mentions are on for {name}", { name: person.name }), "success"); onChanged(); }
  }
  if (runner?.enabled) return <p className="setting-note">{t("On. Write @ai in a note to ask {name}, then press “Send to AI” under it.", { name: person.name })}</p>;
  return (
    <div className="member-key-form">
      {!runner && (
        <>
          <label htmlFor={nameId}>{t("Its own @name (for when you have several AIs)")}</label>
          <TextField id={nameId} value={handle} maxLength={32} onChange={(e) => setHandle(e.target.value)} />
        </>
      )}
      <Button variant="secondary" disabled={!online || busy || (!runner && !handle.trim())} onClick={() => void turnOn()}>
        {runner ? t("Resume @ mentions") : t("Turn on @ mentions")}
      </Button>
      <p className="member-hint">{t("The AI itself isn't connected to this server yet, so a request waits as “Sent. The AI isn't connected yet.” until it is.")}</p>
    </div>
  );
}
