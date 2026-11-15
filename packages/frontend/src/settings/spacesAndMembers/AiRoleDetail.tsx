import { useState } from "react";
import { Pause, Play } from "lucide-react";

import { useT } from "../../lib/i18n";
import { spaceLabel, type Space } from "../../lib/spaces";
import { Button } from "../../components/ui";
import { AiActivity, AiRoleStatus, ApiRuntimeSetup, MentionSetup, toggleMention, useMentionRunner } from "../ai";
import HelperKeys from "./HelperKeys";
import { presenceIn, type Roster, type RosterPerson } from "./roster";
import type { RowActions } from "./model";

/** What belongs to an AI role as a whole, not to one space: how it runs, what
 *  it did lately, pause, its settings and keys. Which spaces it is in is the
 *  space list's job; this only warns when that leaves it blind. */
export default function AiRoleDetail({ person, roster, spaces, editable, online, actions }: {
  person: RosterPerson;
  roster: Roster;
  spaces: Space[];
  editable: boolean;
  online: boolean;
  actions: RowActions;
}) {
  const t = useT();
  const { runner, reload: reloadRunner } = useMentionRunner(person.id);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0); // bumps when the role's settings change, so the status below reloads

  const inSpaces = spaces.filter((s) => presenceIn(roster, person, s) !== "none");
  const closed = inSpaces.filter((s) => person.reach[s.id]?.read.blocked_by === "external_ai_off");
  const viaMention = !!runner;
  const viaKeys = person.liveKeys > 0;
  const paused = viaMention && !runner.enabled;

  async function toggle() {
    if (!runner) return;
    setBusy(true);
    await toggleMention(person, runner);
    setBusy(false);
    await reloadRunner();
  }

  return (
    <div className="ai-role" data-person-type="agent">
      <section className="ai-role-block" aria-label={t("How {name} runs", { name: person.name })}>
        <h5>{t("How it runs")}</h5>
        <ul className="ai-role-list">
          {viaMention && <li>{t("Called with @{handle} in Onden", { handle: runner.handle })} · {runner.enabled ? t("On") : t("Paused")}</li>}
          {viaKeys && <li>{t("Connects from your own AI (MCP key)")} · {t("{n} keys", { n: person.liveKeys })}</li>}
          {!viaMention && !viaKeys && runner !== undefined && <li className="member-hint">{t("Not set up to run yet. Open “Settings of this role” to choose a way.")}</li>}
        </ul>
      </section>

      <AiRoleStatus person={person} editable={editable} online={online} refreshKey={settingsVersion} />

      {inSpaces.length === 0 && (
        <p className={editable ? "member-warning" : "member-hint"} role={editable ? "alert" : undefined}>
          {editable ? t("{name} is not in any space, so it can't see any notes. Add it to a space from the list of spaces.", { name: person.name })
            : t("Not in any space, so it can't see any notes.")}
        </p>
      )}
      {editable && closed.map((space) => (
        <p key={space.id} className="member-warning" role="status">
          {t("“{space}” does not let AI read, so {name} can't see its notes.", { space: spaceLabel(space), name: person.name })}{" "}
          <Button variant="secondary" size="sm" disabled={!online} onClick={() => void actions.allowAiRead(space)}>{t("Allow AI to read")}</Button>
        </p>
      ))}

      <AiActivity ai={person} enabled={editable} />

      {editable && (
        <div className="ai-role-actions">
          {viaMention && (
            <Button variant="secondary" size="sm" disabled={!online || busy} onClick={() => void toggle()}>
              {runner.enabled ? <><Pause size={12} aria-hidden="true" /> {t("Pause")}</> : <><Play size={12} aria-hidden="true" /> {t("Resume")}</>}
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-expanded={setup}
            aria-label={t("Settings of the role {name}", { name: person.name })} onClick={() => setSetup(!setup)}>
            {setup ? t("Hide settings") : t("Settings of this role")}
          </Button>
        </div>
      )}
      {editable && setup && (
        <div className="ai-role-setup">
          {!viaMention || paused ? (
            <section className="member-keys" aria-label={t("@ mentions of {name}", { name: person.name })}>
              <h4>{t("Called with @ in a note")}</h4>
              <MentionSetup person={person} runner={runner} online={online} onChanged={() => void reloadRunner()} />
            </section>
          ) : null}
          <ApiRuntimeSetup actorId={person.id} online={online} onChanged={() => { setSettingsVersion((n) => n + 1); actions.reload(); }} />
          <HelperKeys person={person} online={online} onChanged={actions.reload} />
        </div>
      )}
    </div>
  );
}
