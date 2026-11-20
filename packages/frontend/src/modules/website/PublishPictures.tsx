// 「會一起公開的圖」 in the publish dialog: the pictures of the drawings the
// published notes embed, which go on the site with those notes even when the
// drawing itself is in a space that does not publish (backend
// publishing/drawingEmbeds.ts; owner 2026-11-20). Each shows small, with the
// notes it is in, and 「不公開」 keeps that drawing off the site (its
// 「不發布」: no picture anywhere), with a way back. The list is the server's
// preview, so what is shown here is what the snapshot will hold.
import { useState } from "react";
import { Button, Img } from "../../components/ui";
import { addToast, getNode } from "../../lib/appStore";
import { propertyWriter, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { PUBLISHED_ATTR, PUBLISHED_FLAG } from "./publishBlocker";
import type { PublishPreview } from "@onden/contract";

type Picture = NonNullable<PublishPreview["embedded_pictures"]>[number];

export default function PublishPictures({ pictures, titleOf, online, busy, onChanged }: {
  pictures: Picture[];
  /** The published note's title as the site shows it. */
  titleOf: (noteId: string) => string;
  online: boolean;
  busy: boolean;
  /** A drawing was kept off or put back: the preview must be built again. */
  onChanged: () => void;
}) {
  const t = useT();
  const [working, setWorking] = useState<string | null>(null);

  /** Write the drawing's 「發布」 value and build the preview again; false when the write did not go through (reported). */
  async function write(drawingId: string, value: string | undefined): Promise<boolean> {
    setWorking(drawingId);
    try {
      await (value === undefined ? propertyWriter.remove(drawingId, PUBLISHED_ATTR) : propertyWriter.set(drawingId, PUBLISHED_ATTR, value, PUBLISHED_FLAG));
      onChanged();
      return true;
    } catch (error) {
      writeErrors.report(error, addToast);
      return false;
    } finally { setWorking(null); }
  }
  async function keepOff(drawingId: string) {
    const before = getNode(drawingId)?.attrs?.[PUBLISHED_ATTR];
    if (!await write(drawingId, "false")) return;
    addToast(t("The picture stays off the site."), "success",
      { label: t("Undo"), onClick: () => void write(drawingId, before) }, { inDialog: true });
  }

  return (
    <section className="publish-review-warn publish-pictures">
      <h3>{t("Pictures published with the notes ({n})", { n: pictures.length })}</h3>
      <p className="publish-review-hint">{t("A picture embedded in a published note goes on the site with it, even when the drawing is in a private space. Only the picture is published: not the drawing's note, its name or the rest of it.")}</p>
      <ul className="publish-pictures-list">
        {pictures.map((p) => (
          <li key={p.picture} className="publish-picture">
            <Img className="publish-picture-thumb" src={p.picture} alt="" />
            <span className="publish-picture-notes">{t("In {notes}", { notes: p.node_ids.map((id) => `「${titleOf(id)}」`).join("、") })}</span>
            <Button variant="ghost" data-action="keep-picture-off" disabled={!online || busy || working !== null}
              onClick={() => void keepOff(p.source_id)}>
              {working === p.source_id ? "…" : t("Don't make public")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
