import { useState } from "react";

import { useT } from "../../lib/i18n";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { refreshSpaces, spaceApi, spaceLabel, type Space } from "../../lib/spaces";
import type { SpaceCapability } from "@onden/contract";
import { useIsOwner } from "../../lib/capabilities";
import { Button, Switch, TextField } from "../../components/ui";
import SpaceDeleteDialog from "../SpaceDeleteDialog";
import { SPACE_NAME_MAX } from "@onden/markdown";

// 「X 裡的筆記」: what notes in a space may do (publish, AI reading, backup) as
// switches, then rename and delete. Who is in a space is not set here; that is
// the member list's permission menus, so there is one place for it.
// The website is the workspace owner's (owner 2026-11-14): a member's personal
// space has no 「發布到網站」 switch (the server refuses it too).

const CAPABILITIES: Array<{ key: SpaceCapability; label: string; hint: string; more?: boolean }> = [
  { key: "publish", label: "Publish to the website", hint: "Every note here goes on your public website when you publish. You can keep a note off. Notes taken off the site come back only the next time you publish." },
  { key: "external_ai", label: "AI can read", hint: "Your AI can read the notes here." },
  { key: "backup", label: "Include in backups", hint: "Notes here are copied into your backups." },
  { key: "shared_seen", label: "Shared “seen” in the RSS reader", hint: "One person marking an item seen marks it for everyone here.", more: true },
  { key: "members_can_move_out", label: "Members who can edit may move notes out", hint: "Otherwise only the owner can move notes to another space.", more: true },
];

/** The switches for what notes in `space` may do; the less common ones sit
 *  behind 「更多設定」, rename and delete under them. */
export default function SpaceSwitches({ space, onChanged }: { space: Space; onChanged: () => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const [more, setMore] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [rename, setRename] = useState(space.name);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try { await action(); await refreshSpaces(); onChanged(); return true; }
    catch (error) { writeErrors.report(error, addToast); return false; }
    finally { setBusy(false); }
  }

  const shared = space.kind === "shared";
  const offered = CAPABILITIES.filter((c) => (shared || (c.key !== "shared_seen" && c.key !== "members_can_move_out" && c.key !== "external_ai"))
    && (c.key !== "publish" || shared || isOwner));
  const renderSwitch = (c: (typeof CAPABILITIES)[number]) => (
    <label key={c.key} className="sm-switch">
      <Switch on={space.capabilities[c.key] === true} label={t(c.label)} disabled={busy}
        onChange={(on) => void run(() => spaceApi.update(space.id, { capabilities: { [c.key]: on } }))} />
      <span className="sm-switch-text"><strong>{t(c.label)}</strong><small>{t(c.hint)}</small></span>
    </label>
  );
  const canRenameOrDelete = shared && !space.is_default;
  return (
    <section className="sm-switches" aria-label={t("Notes in {space}", { space: spaceLabel(space) })}>
      <h4>{t("Notes in {space}", { space: spaceLabel(space) })}</h4>
      {offered.filter((c) => !c.more).map(renderSwitch)}
      {more && offered.filter((c) => c.more).map(renderSwitch)}
      <div className="sm-switches-actions">
        {offered.some((c) => c.more) && (
          <Button variant="ghost" size="sm" aria-expanded={more}
            aria-label={t("More settings of {space}", { space: spaceLabel(space) })} onClick={() => setMore(!more)}>
            {more ? t("Fewer settings") : t("More settings")}
          </Button>
        )}
        {canRenameOrDelete && !renaming && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRename(space.name); setRenaming(true); }}>{t("Rename")}</Button>
        )}
        {canRenameOrDelete && (
          <Button variant="ghost" size="sm" className="settings-text-danger" disabled={busy} onClick={() => setDeleting(true)}>{t("Delete space…")}</Button>
        )}
      </div>
      {renaming && canRenameOrDelete && (
        <form className="spaces-create" onSubmit={(e) => { e.preventDefault(); void run(() => spaceApi.update(space.id, { name: rename.trim() })).then((ok) => { if (ok) setRenaming(false); }); }}>
          <TextField value={rename} onChange={(e) => setRename(e.target.value)} aria-label={t("Space name")} maxLength={SPACE_NAME_MAX} disabled={busy} autoFocus />
          <Button type="submit" variant="primary" size="sm" disabled={busy || !rename.trim() || rename.trim() === space.name}>{t("Rename")}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenaming(false)}>{t("Cancel")}</Button>
        </form>
      )}
      {deleting && <SpaceDeleteDialog space={space} onClose={() => setDeleting(false)} />}
    </section>
  );
}
