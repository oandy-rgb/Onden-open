import { useState } from "react";
import { Lock, Plus, Users } from "lucide-react";

import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { refreshSpaces, spaceApi, spaceLabel, type Space } from "../../lib/spaces";
import { Button, Pressable, TextField } from "../../components/ui";
import { PermissionControl } from "../ai";
import { presenceIn, type RosterPerson } from "./roster";
import { useAudienceText } from "./sentences";
import type { ListContext } from "./model";
import { SPACE_NAME_MAX } from "@onden/markdown";

/** The spaces, one row each: icon, name, who sees it, and a small 「有發布」 when
 *  it is published. With `person` the row's right side is that person's standing
 *  there (a menu, or 「看不到」 and 「加入」); without, it is just the row. */
export default function SpaceList({ spaces, selectedId, person, onSelect, onCreated, ...ctx }: ListContext & {
  spaces: Space[];
  selectedId: string | null;
  person: RosterPerson | null;
  onSelect: (space: Space) => void;
  onCreated: (id: string) => void;
}) {
  const t = useT();
  const audience = useAudienceText();
  return (
    <ul className="sm-list" aria-label={t("Spaces")}>
      {spaces.map((space) => {
        const presence = person ? presenceIn(ctx.roster, person, space) : null;
        const Icon = space.kind === "personal" ? Lock : Users;
        return (
          <li key={space.id} className={presence === "none" ? "sm-row is-away" : "sm-row"} data-space-id={space.id}>
            <Pressable className="sm-row-main" aria-current={space.id === selectedId ? "true" : undefined} onClick={() => onSelect(space)}>
              <Icon size={16} aria-hidden="true" className="sm-row-icon" />
              <span className="sm-row-text">
                <span className="sm-row-name">{spaceLabel(space)}</span>
                <span className="sm-row-sub">{audience(ctx.roster, space)}</span>
              </span>
              {space.capabilities.publish === true && <span className="sm-tag">{t("Publishing")}</span>}
            </Pressable>
            {person && <StandingCell person={person} space={space} {...ctx} />}
          </li>
        );
      })}
      {ctx.editable && !person && <NewSpaceRow onCreated={onCreated} />}
    </ul>
  );
}

function StandingCell({ person, space, roster, editable, online, busyCell, actions }: ListContext & { person: RosterPerson; space: Space }) {
  const t = useT();
  const presence = presenceIn(roster, person, space);
  if (presence === "owner") return <span className="standing standing--owner">{t("Owner")}</span>;
  if (presence === "none") {
    return (
      <span className="sm-row-end">
        <span className="sm-away">{t("Can't see")}</span>
        {editable && space.kind === "shared" && (
          <Button variant="secondary" size="sm" disabled={!online || busyCell === `${person.id}:${space.id}`}
            aria-label={t("Add {name} to {space}", { name: person.name, space: spaceLabel(space) })}
            onClick={() => void actions.changeStanding(person, space, person.type === "agent" ? "view" : "edit")}>
            {t("Add")}
          </Button>
        )}
      </span>
    );
  }
  return (
    <PermissionControl label={t("{name} in {space}", { name: person.name, space: spaceLabel(space) })} name={person.name}
      value={presence} readOnly={!editable || !online} busy={busyCell === `${person.id}:${space.id}`}
      onChange={(next) => void actions.changeStanding(person, space, next)} />
  );
}

/** 「＋ 新空間」: the last row; it turns into a name field. */
function NewSpaceRow({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const made = await spaceApi.create(trimmed);
      setName(""); setOpen(false);
      await refreshSpaces();
      if (made?.id) onCreated(made.id);
    } catch (error) { writeErrors.report(error, addToast); }
    finally { setBusy(false); }
  }
  if (!open) {
    return (
      <li className="sm-row sm-row--add">
        <Pressable className="sm-row-main" onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" className="sm-row-icon" /> {t("New space")}</Pressable>
      </li>
    );
  }
  return (
    <li className="sm-row sm-row--form">
      <form className="spaces-create" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder={t("New shared space, e.g. Lab")}
          aria-label={t("New shared space name")} disabled={busy} maxLength={SPACE_NAME_MAX} autoFocus />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !name.trim()}>{t("Create space")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setOpen(false); setName(""); }}>{t("Cancel")}</Button>
      </form>
    </li>
  );
}
