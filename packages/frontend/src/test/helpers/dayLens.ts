// A GET /api/day/:date/lens answer for a test, in the shape the server sends
// (@onden/markdown DayLens): the notes of the day under `buckets`. Typed, so a
// mock in another shape fails the type check instead of passing on its own.
import type { DayItem, DayLens, DayLensBucket, DayLensNote } from "@onden/markdown";

const empty = <T>(): DayLensBucket<T> => ({ items: [], total: 0 });

export function dayLensOf(date: string, parts: {
  items?: DayItem[];
  created?: DayLensBucket<DayLensNote>;
  edited?: DayLensBucket<DayLensNote>;
  agent?: DayLensBucket<DayLensNote>;
} = {}): DayLens {
  return {
    date,
    items: parts.items ?? [],
    buckets: {
      created: parts.created ?? empty(),
      edited: parts.edited ?? empty(),
      agent: parts.agent ?? empty(),
      due: empty(),
    },
  };
}
