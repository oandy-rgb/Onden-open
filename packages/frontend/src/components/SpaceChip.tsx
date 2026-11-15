import { useEffect, useState } from "react";
import { Lock, Users } from "lucide-react";
import type { ContentNode } from "../lib/api";
import { useT } from "../lib/i18n";
import { memberLabel } from "../lib/actorLabel";
import { spaceApi, spaceLabel, useSpaces, type Space, type SpaceMember } from "../lib/spaces";
import { useCapabilities } from "../lib/capabilities";
import { openSpacesAndMembers } from "../lib/settingsRequest";
import "./ConfirmDialog.css";
import { Button, Modal, Pressable, Select } from "./ui";
import MoveToSpaceConfirm from "./MoveToSpaceConfirm";
import { isTag } from "@onden/markdown/contract";

// The note's space, next to its title (docs/architecture/spaces.md 「介面」):
// the one fact that decides who can see it. Opening it shows who that is and
// offers "Move to another space…", which first says exactly who gains and loses access.
export default function SpaceChip({ node, online, onMoved }: { node: ContentNode; online: boolean; onMoved?: () => void }) {
  const t = useT();
  const { spaces } = useSpaces(online);
  const [open, setOpen] = useState(false);
  const current = spaces.find((s) => s.id === node.space_id);
  if (!node.space_id || isTag(node)) return null;
  const label = current ? spaceLabel(current) : t("Shared space");
  const Icon = current?.kind === "personal" ? Lock : Users;
  return (
    <>
      <Pressable type="button" className="space-chip tap-target" onClick={() => setOpen(true)} aria-haspopup="dialog"
        title={t("Who can see this note")}>
        <Icon size={11} aria-hidden="true" /> {label}
      </Pressable>
      {open && (
        <SpaceDialog node={node} current={current} spaces={spaces} online={online}
          onClose={() => setOpen(false)} onMoved={() => { setOpen(false); onMoved?.(); }} />
      )}
    </>
  );
}

function SpaceDialog({ node, current, spaces, online, onClose, onMoved }: {
  node: ContentNode; current: Space | undefined; spaces: Space[]; online: boolean;
  onClose: () => void; onMoved: () => void;
}) {
  const t = useT();
  const caps = useCapabilities(online);
  const [members, setMembers] = useState<SpaceMember[] | null>(null);
  // The space picked below: the same confirmation as 「移動到…」 and a sidebar drop (MoveToSpaceConfirm).
  const [target, setTarget] = useState<Space | null>(null);
  useEffect(() => {
    if (!current || !online) return;
    let cancelled = false;
    spaceApi.members(current.id).then((m) => { if (!cancelled) setMembers(m); }).catch(() => { /* list stays hidden */ });
    return () => { cancelled = true; };
  }, [current, online]);
  const destinations = spaces.filter((s) => s.id !== node.space_id && caps.canMoveInto(s));

  if (target) {
    return <MoveToSpaceConfirm node={node} to={target} parentTitle={null} title={t("Who can see this note")} backLabel={t("Back")}
      onBack={() => setTarget(null)} onMoved={onMoved} onClose={onClose} />;
  }

  return (
    <Modal label={t("Who can see this note")} className="confirm-dialog-backdrop" onClose={onClose}>
      <div className="confirm-dialog space-dialog">
        <h2 className="confirm-dialog-title">{t("Who can see this note")}</h2>
        <p className="confirm-dialog-message">
          {current ? t("It is in {space}.", { space: spaceLabel(current) }) : t("It is in a shared space.")}
        </p>
        {members && (
          <ul className="space-dialog-members">
            {members.map((m) => (
              <li key={m.id}>{memberLabel(m)} <span>{m.permission === "edit" ? t("Can edit") : t("Can read")}</span></li>
            ))}
          </ul>
        )}
        {current?.kind === "shared" && (
          <Button size="sm" className="space-dialog-manage"
            onClick={() => { onClose(); openSpacesAndMembers(current.id); }}><Users size={13} aria-hidden="true" /> {t("Members and permissions")}</Button>
        )}
        {destinations.length > 0 && current && caps.canMoveOut(current) && caps.canEdit(node) && (
          <label className="space-dialog-move">
            <span>{t("Move to another space…")}</span>
            <Select value="" onChange={(e) => setTarget(destinations.find((s) => s.id === e.target.value) ?? null)} disabled={!online}>
              <option value="">{t("Choose a space")}</option>
              {destinations.map((s) => <option key={s.id} value={s.id}>{spaceLabel(s)}</option>)}
            </Select>
          </label>
        )}
        <div className="confirm-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose}>{t("Close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
