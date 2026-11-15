import { useId, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";

import { addToast } from "../../lib/appStore";
import { sendWrite, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import type { Space } from "../../lib/spaces";
import { Button, TextField } from "../../components/ui";
import AiRoleStatus from "./AiRoleStatus";
import ApiRuntimeSetup from "./ApiRuntimeSetup";
import { toggleMention, useMentionRunner } from "./HelperMention";
import type { AiRoleInfo } from "./aiRoleInfo";
import type { Standing } from "./PermissionControl";
import { StandingCell, useAllowAiRead, useStandingWriter } from "./standing";
import AiActivity from "./AiActivity";
import { deleteAi } from "./actions";
import { ConnectionLine } from "./ConnectionCards";
import { useOffReason } from "./AiCard";
import type { RoleConnection, RoleState } from "./model";
import { AI_NAME_MAX } from "./model";
import "./strings";

/** 編輯 AI: its name and @name, what it runs on (model and monthly limit), where it stands in each space, its review
 *  rule, what it did lately, pause and remove. The space rows are the shared standing writer (standing/standing.tsx):
 *  the same one 「空間與成員」 uses to show the spaces from the other side. */
export default function AiEditor({ role, connection, state, spaces, online, onChangeConnection, onChanged, onClose }: {
  role: AiRoleInfo; connection: RoleConnection; state: RoleState;
  /** Shared spaces. */
  spaces: readonly Space[]; online: boolean;
  onChangeConnection: () => void; onChanged: () => void | Promise<void>; onClose: () => void;
}) {
  const t = useT();
  const offReason = useOffReason();
  const ids = { name: useId(), handle: useId() };
  const [name, setName] = useState(role.name);
  const [handle, setHandle] = useState(role.handle);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const { runner, reload: reloadRunner } = useMentionRunner(role.actor_id);
  const roleRef = useRef(role);
  roleRef.current = role;

  const standing = useStandingWriter({
    previousOf: (_personId, space) => roleRef.current.spaces[space.id] ?? "none",
    reload: onChanged,
  });
  const allowAiRead = useAllowAiRead(onChanged);
  const ai = { id: role.actor_id, name: role.name };

  const handleChanged = handle.trim().toLowerCase() !== role.handle;
  const nameChanged = name.trim() !== role.name;
  async function saveNames() {
    if (busy || !name.trim() || !handle.trim() || (!nameChanged && !handleChanged)) return;
    setBusy(true);
    try {
      if (nameChanged) await sendWrite("PATCH", `/api/actors/${role.actor_id}`, { name: name.trim() });
      if (handleChanged) await sendWrite("PUT", `/api/agent-sessions/runners/${role.actor_id}`, { handle: handle.trim().toLowerCase() });
      addToast(t("Saved."), "success");
    } catch (error) { writeErrors.report(error, addToast); }
    finally {
      // Whatever was saved shows, even when a later step (the @name) was refused.
      setBusy(false);
      await onChanged();
    }
  }

  async function togglePause() {
    if (!runner) return;
    setBusy(true);
    await toggleMention(ai, runner);
    setBusy(false);
    await reloadRunner();
    await onChanged();
  }
  async function remove() {
    setBusy(true);
    const gone = await deleteAi(ai);
    setBusy(false);
    if (gone) { await onChanged(); onClose(); }
  }

  return (
    <div className="ai-editor" data-person-type="agent">
      {state.state === "off" && <p className="member-warning" role="status">{offReason(state.reason)}</p>}

      <form className="ai-block member-key-form" aria-label={t("Name of {name}", { name: role.name })} onSubmit={(e) => { e.preventDefault(); void saveNames(); }}>
        <label htmlFor={ids.name}>{t("Name")}</label>
        <TextField id={ids.name} value={name} maxLength={AI_NAME_MAX} onChange={(e) => setName(e.target.value)} />
        <label htmlFor={ids.handle}>{t("Its own @name (for when you have several AIs)")}</label>
        <TextField id={ids.handle} value={handle} maxLength={32} onChange={(e) => setHandle(e.target.value)} />
        <Button type="submit" variant="secondary" className="ai-touch" disabled={!online || busy || !name.trim() || !handle.trim() || (!nameChanged && !handleChanged)}>{t("Save name")}</Button>
      </form>

      <section className="ai-block" aria-label={t("Connection of {name}", { name: role.name })}>
        <h5>{t("Connection")}</h5>
        <p className="ai-card-line"><ConnectionLine connection={connection} seenAt={role.runtimes.find((r) => r.kind === "mcp")?.last_seen_at ?? null} /></p>
        <Button variant="secondary" size="sm" className="ai-touch" disabled={!online} onClick={onChangeConnection}>{t("Change connection")}</Button>
        <ApiRuntimeSetup actorId={role.actor_id} online={online} onChanged={() => { setVersion((n) => n + 1); void onChanged(); }} />
      </section>

      <section className="ai-block" aria-label={t("Spaces of {name}", { name: role.name })}>
        <h5>{t("Spaces")}</h5>
        {spaces.length === 0 ? <p className="member-hint">{t("There are no shared spaces yet.")}</p> : (
          <ul className="standing-cells">
            {spaces.map((space) => (
              <StandingCell key={space.id} person={ai} space={space} value={(role.spaces[space.id] ?? "none") as Standing}
                busy={!online || standing.busyCell === `${role.actor_id}:${space.id}`}
                onChange={(next) => void standing.change(ai, space, next)} onAllowAiRead={() => void allowAiRead(space)} />
            ))}
          </ul>
        )}
      </section>

      <AiRoleStatus person={ai} editable online={online} refreshKey={version} />
      <AiActivity ai={ai} enabled />

      <div className="ai-flow-actions">
        {runner && (
          <Button variant="secondary" className="ai-touch" disabled={!online || busy} onClick={() => void togglePause()}>
            {runner.enabled ? <><Pause size={13} aria-hidden="true" /> {t("Pause")}</> : <><Play size={13} aria-hidden="true" /> {t("Resume")}</>}
          </Button>
        )}
        <Button variant="ghost" className="ai-touch settings-text-danger" disabled={!online || busy} onClick={() => void remove()}><Trash2 size={13} aria-hidden="true" /> {t("Remove this AI")}</Button>
      </div>
    </div>
  );
}
