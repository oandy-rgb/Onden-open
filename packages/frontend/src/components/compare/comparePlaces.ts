// What the two-version compare view (TextCompare) tells its caller, and what a caller may tell it.
// Types and two pure helpers only: no @codemirror here, so a caller that is not itself lazy can
// import them without pulling the compare view into its chunk.
//
// Contract
//   <TextCompare before after beforeLabel afterLabel places? placeActions? layout? />
//   * The view only shows. It never edits either text and never calls acceptChunk/rejectChunk:
//     "accepted" is something a caller's own save path decides (an AI suggestion: the server).
//   * A "place" is one spot where the two texts differ. `places` (optional) is the caller's own
//     cut, in `before`/`after` offsets, when it already knows where the changes are (an AI
//     suggestion knows its places; guessing them again with a diff would be a second opinion).
//     Without it the view finds the places itself.
//   * `placeActions(place)` returns the buttons for one place (or null). The view puts them next
//     to "place 2 of 5" and gives the caller the place back, so it can find its own thing for it:
//     the AI suggestion whose range `touches` the place, the conflict it came from, ...
//
// Examples
//   history:   <TextCompare before={then} after={now} beforeLabel="當時" afterLabel="現在" />
//   AI:        <TextCompare before={markdown} after={withSuggestions} places={ranges}
//                placeActions={(place) => itemsAt(place).map(i => <Button onClick={() => decide(i)}>…</Button>)} />
//   conflicts (next batch): split a three-way conflict into its conflicting hunks, then per hunk
//              <TextCompare before={mine} after={theirs} beforeLabel="你的" afterLabel="對方的"
//                placeActions={() => <><Button onClick={keepMine}/><Button onClick={keepTheirs}/></>} />

export type CompareRange = { from: number; to: number };

/** A place the caller already knows: where it sits in `before` and in `after`. */
export type CompareChange = { before: CompareRange; after: CompareRange };

/** A place as the view found it (or took it from the caller), in document order. */
export type ComparePlace = {
  /** 0-based position in document order. */
  index: number;
  before: CompareRange & { text: string };
  after: CompareRange & { text: string };
};

/** Whether `range` (in `after` offsets) is part of the place. Ranges that only meet at an edge are
 *  different places; an empty range (a removal) counts when it sits inside or on the edge of the place. */
export function placeTouches(place: ComparePlace, range: CompareRange): boolean {
  const { from, to } = place.after;
  if (range.from === range.to || from === to) return range.from <= to && range.to >= from;
  return range.from < to && range.to > from;
}
