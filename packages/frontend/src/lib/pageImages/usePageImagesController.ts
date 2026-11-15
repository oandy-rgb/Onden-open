import { useMemo } from "react";
import type { PageImagesDoc } from "@onden/markdown/page-images";
import { savePageImages } from "../data";
import { useLayerController } from "../pageLayer";
import { PageImagesController, type ImageSelection } from "./controller";

/** Which note's pictures a surface shows: the note and its stored value as
 *  loaded (OverviewEditor reads it with the drawing). */
export type PageImagesSource = { nodeId: string; initial: string | null };

/** The note's pictures for one open surface, and the selected one. Saves go to
 *  the note the surface was loaded for (what is pending is saved as
 *  useLayerController says). */
export function usePageImagesController(source: PageImagesSource | undefined, readOnly = false): { controller: PageImagesController | null; doc: PageImagesDoc | null; selection: ImageSelection | null } {
  const nodeId = source?.nodeId;
  const controller = useMemo(
    () => (source ? new PageImagesController({ initial: source.initial, readOnly, save: (value, base) => savePageImages(source.nodeId, value, base) }) : null),
    // The controller belongs to the note: the surface is remounted per note (key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, readOnly],
  );
  return useLayerController<PageImagesDoc, ImageSelection, PageImagesController>(controller);
}
