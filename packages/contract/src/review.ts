// The review module's wire shapes (GET /api/review/queue, /stats, /status and
// the grade, tomorrow, suspend and resume routes). Pure types: the backend
// builds them (modules/review/service.ts), the frontend reads them.

/** 1 = again, 2 = hard, 3 = good, 4 = easy. */
export type ReviewRating = 1 | 2 | 3 | 4;

/** One person's schedule for one card. */
export type ReviewState = {
  /** ISO timestamp the card becomes due again. */
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  /** Times graded Again. */
  lapses: number;
  state: "review";
  last_review: string;
  /** First grade in this retained schedule, for daily new-card accounting. */
  introduced_at?: string;
};

/** Body of POST /api/review/:id/grade (and /blocks/:id/grade). `seen_reps` is the
 *  card's `state.reps` the client was showing (0 for a new card): if another
 *  device graded the card since, the server answers 409 and writes nothing.
 *  Absent (older clients): graded against whatever is stored. */
export type ReviewGradeRequest = { rating: ReviewRating; now?: string; seen_reps?: number };

/** Body of POST /api/review/:id/undo-grade. `graded_id` is the `grade_id` the
 *  grade response gave: the one grade this undo may remove. `graded_reps` is
 *  the `state.reps` that grade produced. If another device graded since (or
 *  undid it and graded again, which restores the same reps), the server
 *  answers 409 and keeps what is stored. Absent (older clients): undoes
 *  whatever grade is stored. */
export type ReviewUndoRequest = { graded_reps?: number; graded_id?: string };

/** Answer of the grade routes: the new schedule and `grade_id`, which names
 *  this grade (not the card) for ReviewUndoRequest.graded_id. */
export type ReviewGradeResult = { node_id: string; block_id?: string; rating: ReviewRating; state: ReviewState; grade_id: string };

/** Days until the card comes back after each grade, from the scheduler the
 *  server grades with (the screen shows these, it never works them out). */
export type ReviewIntervals = Record<ReviewRating, number>;

/** What surrounds a card in its source, shown once the answer is revealed.
 *  A paragraph card: the note's name and the paragraphs before and after.
 *  A whole-note card: the name of its parent (`before`/`after` null). */
export type ReviewContext = {
  source_title: string | null;
  before: string | null;
  after: string | null;
};

/** A card: a whole note (`block` null; title = front, body = back), or one
 *  paragraph of a note (`block` set; `node_id` is its note; `ref` is the
 *  paragraph's id in that note). */
export type ReviewCard = {
  node_id: string;
  title: string;
  markdown: string;
  ink_data: string | null;
  state: ReviewState | null;
  block: { id: string; ref: string } | null;
  next_days: ReviewIntervals;
  context: ReviewContext;
};

export type ReviewQueue = { cards: ReviewCard[]; total: number };

/** What the groups are made of: the person's tags, or the top-most notes that hold cards. */
export type ReviewGroupBy = "tag" | "note";

/** One group on GET /api/review/groups. `id` is the tag or the note the session is
 *  limited to (`tag_id` / `root` of the queue); null is the cards no tag group covers
 *  (queue `untagged=true`), whose `title` is "". `due` and `new` are what a session of
 *  the group gives today, under the person's one daily cap. */
export type ReviewGroup = { id: string | null; title: string; due: number; new: number };

export type ReviewGroups = { by: ReviewGroupBy; groups: ReviewGroup[] };

/** A card the person has left out of their reviews until they resume it. */
export type ReviewHold = { suspended: boolean; until: string | null };

/** A card reference for the status page: its source note, and the paragraph
 *  when it is a paragraph card. */
export type ReviewStatusCard = {
  node_id: string;
  title: string;
  lapses: number;
  block: { id: string; ref: string } | null;
};

export type ReviewForecastDay = { date: string; count: number };

/** GET /api/review/status — one person's reviews, counted by workspace day. */
export type ReviewStatus = {
  /** The workspace's today, YYYY-MM-DD. */
  today_date: string;
  /** Cards due before today that are still within today's cap. */
  overdue: number;
  /** Cards due today, within the cap. */
  today: number;
  new_available: number;
  /** Due cards the daily cap pushed to tomorrow. */
  rolled_over: number;
  /** The person's cap, or null when there is none; and today's count against it. */
  reviews_per_day: number | null;
  reviewed_today: number;
  /** The next seven days, tomorrow first, not counting overdue. */
  forecast: ReviewForecastDay[];
  /** Cards forgotten `forgotten_min` or more times, most forgotten first. */
  forgotten_min: number;
  forgotten: ReviewStatusCard[];
  /** Cards the person stopped reviewing, so the page can offer them back. */
  stopped: ReviewStatusCard[];
};
