// A note's deck choices, read from and written to its `slides_data` attribute
// (@onden/markdown/slidesData) through the ordinary attribute writer: the change
// shows at once, is queued while offline, is kept in the note's history and can
// be restored there. A refused write is put back and reported by the writer.
import { useMemo } from "react";
import { SLIDES_DATA_ATTR, parseSlidesData, serializeSlidesData, type SlidesData } from "@onden/markdown";
import { propertyWriter, runBackgroundWrite } from "../../lib/data";
import type { ContentNode } from "../../lib/api";

export function useSlidesData(node: ContentNode): { data: SlidesData; change: (next: SlidesData) => void } {
  const raw = node.attrs?.[SLIDES_DATA_ATTR];
  const data = useMemo(() => parseSlidesData(raw), [raw]);
  const change = (next: SlidesData) => {
    const text = serializeSlidesData(next);
    // A choice taken back removes the attribute rather than leaving an empty one.
    runBackgroundWrite(text === null ? propertyWriter.remove(node.id, SLIDES_DATA_ATTR) : propertyWriter.set(node.id, SLIDES_DATA_ATTR, text));
  };
  return { data, change };
}
