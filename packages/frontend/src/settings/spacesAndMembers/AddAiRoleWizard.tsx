import { useId, useState } from "react";

import { addToast } from "../../lib/appStore";
import { aiRoleWriter, workspaceAccessWriter, writeErrors } from "../../lib/data";
import { t as translate, useT } from "../../lib/i18n";
import { refreshSpaces, spaceApi, spaceLabel } from "../../lib/spaces";
import { Button, Radio, TextField } from "../../components/ui";
import { ApiSettingsFields, apiSettingsBody, apiSettingsReady, EMPTY_API_SETTINGS, FreshKey, PermissionControl, useApiKeys, useStandingLabel, type ApiSettings, type Standing } from "../ai";
import type { RosterSpace } from "./roster";

// 「新增 AI 角色」, one question at a time: name → how it runs → that way's
// settings → which spaces → done. There are two ways to run an AI (RUN_MODES): the
// API (Onden calls it with your key; it can only suggest) and MCP (your own AI client
// connects, by hand or kept on a machine). A way is a title, one plain sentence, its
// settings and what to do after the role exists.

type Setup = { handle: string; keyName: string; keyAccess: "read" | "write"; api: ApiSettings };
type RunModeId = "api" | "mcp";
type Created = { name: string; key: { name: string; plaintext: string } | null };

type RunMode = {
  id: RunModeId;
  title: string;
  /** One plain sentence: what it is and what it means for you. */
  about: string;
  ready: (setup: Setup) => boolean;
  /** After the role exists and is in its spaces. Returns a key to show once, if it made one. */
  finish: (actorId: string, setup: Setup, roleName: string) => Promise<Created["key"]>;
};

/** Both ways answer to an @name in a note, so both get one and are switched on. */
async function enableRole(actorId: string, setup: Setup): Promise<void> {
  await aiRoleWriter.setMentionName(actorId, setup.handle.trim().toLowerCase());
  await aiRoleWriter.setMentionEnabled(actorId, true);
}

const RUN_MODES: RunMode[] = [
  {
    id: "api",
    title: "API",
    about: "Onden calls the AI with your own API key; it can only suggest changes, and you accept each one.",
    ready: (s) => !!s.handle.trim() && apiSettingsReady(s.api),
    finish: async (actorId, setup) => {
      await enableRole(actorId, setup);
      await aiRoleWriter.setRuntime(actorId, { default_runtime: "api", api: apiSettingsBody(setup.api) });
      return null;
    },
  },
  {
    id: "mcp",
    title: "MCP",
    about: "Your own AI client connects with a key, opened by hand or kept on a machine that picks up waiting requests.",
    ready: (s) => !!s.handle.trim(),
    finish: async (actorId, setup, roleName) => {
      await enableRole(actorId, setup);
      const label = setup.keyName.trim() || (setup.keyAccess === "read" ? translate("Read-only key") : translate("Read and write key"));
      const minted = await aiRoleWriter.mintCode(actorId, { name: label, access: setup.keyAccess });
      return { name: setup.keyName.trim() || roleName, plaintext: (minted as { token: string }).token };
    },
  },
];

const STEPS = ["Name", "How it runs", "Its settings", "Spaces", "Done"] as const;

export default function AddAiRoleWizard({ spaces, online, defaultSpaceId, onCreated, onCancel }: {
  spaces: RosterSpace[];
  online: boolean;
  /** A space to start the role in, when the wizard was opened from that space. */
  defaultSpaceId?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const standingLabel = useStandingLabel();
  const ids = { name: useId(), handle: useId(), keyName: useId(), access: useId(), mode: useId() };
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const { offered: apiOffered, keys: apiKeys } = useApiKeys();
  const [modeId, setModeId] = useState<RunModeId>("mcp");
  const [setup, setSetup] = useState<Setup>({ handle: "ai", keyName: "", keyAccess: "read", api: EMPTY_API_SETTINGS });
  const [standing, setStanding] = useState<Record<string, Standing>>(defaultSpaceId ? { [defaultSpaceId]: "view" } : {});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const mode = RUN_MODES.find((m) => m.id === modeId)!;
  const chosen = Object.entries(standing).filter(([, s]) => s !== "none") as Array<[string, "view" | "edit"]>;
  const canNext = step === 0 ? !!name.trim() : step === 2 ? mode.ready(setup) : step === 3 ? chosen.length > 0 : true;

  async function create() {
    if (busy) return;
    setBusy(true);
    let actorId: string | undefined;
    try {
      actorId = (await workspaceAccessWriter.addMember({ name: name.trim(), type: "agent" }))?.id;
    } catch (error) { writeErrors.report(error, addToast); setBusy(false); return; }
    if (!actorId) { onCreated(); setBusy(false); onCancel(); return; }
    let key: Created["key"] = null;
    try {
      for (const [spaceId, permission] of chosen) await spaceApi.setMember(spaceId, actorId, permission);
      await refreshSpaces();
      key = await mode.finish(actorId, setup, name.trim());
    } catch (error) {
      writeErrors.report(error, addToast);
      addToast(t("{name} was added, but not every step worked. Check its card.", { name: name.trim() }), "error");
    }
    setBusy(false);
    onCreated();
    if (key) setCreated({ name: name.trim(), key }); else onCancel();
  }

  if (created?.key) {
    return (
      <section className="member-add" aria-label={t("New AI role")}>
        <h4>{t("{name} is ready", { name: created.name })}</h4>
        <FreshKey name={created.key.name} plaintext={created.key.plaintext} onDone={onCancel} doneVariant="primary" />
      </section>
    );
  }

  return (
    <form className="member-add" aria-label={t("New AI role")} onSubmit={(e) => { e.preventDefault(); if (step === STEPS.length - 1) void create(); else if (canNext) setStep(step + 1); }}>
      <p className="wizard-steps" aria-live="polite">{t("Step {n} of {total}: {title}", { n: step + 1, total: STEPS.length, title: t(STEPS[step]!) })}</p>

      {step === 0 && (
        <>
          <label htmlFor={ids.name}>{t("What should this AI role be called?")}</label>
          <TextField id={ids.name} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="@ai" />
        </>
      )}

      {step === 1 && (
        <fieldset className="wizard-modes">
          <legend>{t("How should it run?")}</legend>
          {RUN_MODES.map((m) => {
            const missing = m.id === "api" ? (!apiOffered ? t("This server can't keep API keys yet.") : apiKeys.length === 0 ? t("Add an API key in “API keys” first.") : null) : null;
            return (
              <label key={m.id} className={m.id === modeId ? "wizard-mode is-selected" : "wizard-mode"}>
                <Radio name={ids.mode} checked={m.id === modeId} disabled={missing !== null} onChange={() => setModeId(m.id)} />
                <span><strong>{t(m.title)}</strong><small>{t(m.about)}</small>{missing && <small>{missing}</small>}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      {step === 2 && (
        <>
          <label htmlFor={ids.handle}>{t("Its own @name (for when you have several AIs)")}</label>
          <TextField id={ids.handle} value={setup.handle} maxLength={32} onChange={(e) => setSetup({ ...setup, handle: e.target.value })} />
        </>
      )}
      {step === 2 && modeId === "api" && (
        <ApiSettingsFields value={setup.api} onChange={(api) => setSetup({ ...setup, api })} keys={apiKeys} />
      )}
      {step === 2 && modeId === "mcp" && (
        <>
          <label htmlFor={ids.keyName}>{t("Key name (optional)")}</label>
          <TextField id={ids.keyName} value={setup.keyName} maxLength={80} onChange={(e) => setSetup({ ...setup, keyName: e.target.value })} />
          <div className="member-key-access" role="radiogroup" aria-label={t("What the key may do")}>
            <label><Radio name={ids.access} checked={setup.keyAccess === "read"} onChange={() => setSetup({ ...setup, keyAccess: "read" })} /> {t("Read-only: can look things up, changes nothing")}</label>
            <label><Radio name={ids.access} checked={setup.keyAccess === "write"} onChange={() => setSetup({ ...setup, keyAccess: "write" })} /> {t("Read and write: can add and change notes where {name} can edit", { name: name.trim() })}</label>
          </div>
        </>
      )}

      {step === 3 && (
        <fieldset className="member-add-spaces">
          <legend>{t("Spaces it can enter (choose at least one)")}</legend>
          {spaces.length === 0 ? <p className="member-hint">{t("There are no shared spaces yet. Create one with “New space” first.")}</p> : (
            <ul className="member-spaces">
              {spaces.map((space) => (
                <li key={space.id}>
                  <span className="member-space-name">{spaceLabel(space)}</span>
                  <PermissionControl label={t("{name} in {space}", { name: name.trim(), space: spaceLabel(space) })}
                    name={name.trim()} leave="skip" value={standing[space.id] ?? "none"} busy={busy} onChange={(next) => setStanding({ ...standing, [space.id]: next })} />
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}

      {step === 4 && (
        <div className="wizard-review">
          <p><strong>{name.trim()}</strong> · {t(mode.title)}</p>
          <ul>{chosen.map(([id, permission]) => <li key={id}>{spaceLabel(spaces.find((s) => s.id === id)!)} · {standingLabel(permission)}</li>)}</ul>
          {modeId === "mcp" && <p className="member-hint">{t("The key is shown once on the next screen.")}</p>}
        </div>
      )}

      <div className="member-add-actions">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
        {step > 0 && <Button variant="secondary" disabled={busy} onClick={() => setStep(step - 1)}>{t("Back")}</Button>}
        <Button type="submit" variant="primary" disabled={!online || busy || !canNext}>
          {step === STEPS.length - 1 ? t("Add AI role") : t("Next")}
        </Button>
      </div>
    </form>
  );
}
