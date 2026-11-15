import { SLIDES_DATA_ATTR, parseSlidesData, type SlidesData } from "@onden/markdown";
import type { ContentNode } from "../../lib/api";

/** A note's chosen layouts and theme, read from its `slides_data` attribute. */
export const slidesDataOf = (node: Pick<ContentNode, "attrs">): SlidesData => parseSlidesData(node.attrs?.[SLIDES_DATA_ATTR]);
