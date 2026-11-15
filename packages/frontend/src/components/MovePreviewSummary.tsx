import { useT } from "../lib/i18n";
import { memberLabel } from "../lib/actorLabel";
import type { MovePreviewNumericEpoch } from "../lib/spaces";
import { Button } from "./ui";

// What moving a note to another space changes, from spaceApi.previewMove: how
// many notes go, who gains and loses sight of them, and that the version
// history goes along. Shown before the move in both places that make one — the
// space chip's dialog and the note menu's "Move to…" (MoveToDialog).
export default function MovePreviewSummary({ preview, onManageSpace }: { preview: MovePreviewNumericEpoch; onManageSpace: (spaceId: string) => void }) {
  const t = useT();
  // People only: the built-in System account is an agent actor and is no one to tell about.
  const gainingPeople = preview.gain.filter((m) => m.type !== "agent");
  return (
    <div className="space-dialog-preview" role="status">
      <p>{t(preview.notes === 1 ? "This note moves." : "This note and {n} notes under it move.", { n: preview.notes - 1 })}</p>
      {gainingPeople.length > 0 && <p>{t("Will be able to see it: {names}", { names: gainingPeople.map((m) => m.name).join("、") })}</p>}
      {preview.lose.length > 0 && <p>{t("Will no longer see it: {names}", { names: preview.lose.map((m) => memberLabel(m)).join("、") })}</p>}
      {preview.lose.length > 0 && preview.to.kind === "shared" && (
        <p>
          {preview.lose.some((m) => m.type === "agent") ? t("An AI helper that can't see it won't find this note. To let them, add them to {space} first.", { space: preview.to.name })
            : t("To let them keep seeing it, add them to {space} first.", { space: preview.to.name })}
          {" "}
          <Button type="button" variant="ghost" size="sm"
            onClick={() => onManageSpace(preview.to.id)}>{t("Manage who is in {space}", { space: preview.to.name })}</Button>
        </p>
      )}
      {gainingPeople.length === 0 && preview.lose.length === 0 && <p>{t("The same people can see it.")}</p>}
      <p className="space-dialog-warning">{t("Its version history moves with it, including text you deleted earlier.")}</p>
    </div>
  );
}
