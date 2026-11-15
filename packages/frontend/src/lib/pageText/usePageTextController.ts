import { useMemo } from "react";
import type { PageTextDoc } from "@onden/markdown/page-text";
import { savePageText } from "../data";
import { useLayerController } from "../pageLayer";
import { PageTextController, type BoxSelection } from "./controller";

/** Which note's boxes a surface shows: the note and its stored value as loaded
 *  (OverviewEditor reads it with the drawing). */
export type PageTextSource = { nodeId: string; initial: string | null };

/** The note's text boxes for one open surface. Saves go to the note the
 *  surface was loaded for (what is pending is saved as useLayerController says). */
export function usePageTextController(source: PageTextSource | undefined, readOnly = false): { controller: PageTextController | null; doc: PageTextDoc | null } {
  const nodeId = source?.nodeId;
  const controller = useMemo(
    () => (source ? new PageTextController({ initial: source.initial, readOnly, save: (value, base) => savePageText(source.nodeId, value, base) }) : null),
    // The controller belongs to the note: the surface is remounted per note
    // (key), and a changing `initial` is the echo of our own save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, readOnly],
  );
  const { doc } = useLayerController<PageTextDoc, BoxSelection, PageTextController>(controller);
  return { controller, doc };
}
