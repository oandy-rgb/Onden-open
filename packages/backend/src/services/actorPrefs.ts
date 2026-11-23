import { z } from "zod";
import { INK_PRESET_NAME_MAX, UUID_SOURCE, isHexColor } from "@onden/markdown";
import { INK_SHAPE_KINDS } from "@onden/markdown/ink";
import { q, getWorkspaceId } from "../db.js";
import { mutatePersonal } from "../spine/mutate.js";
import { personalDataOwnerId, isTemporarySessionActor } from "../spine/authority.js";
import { currentStampWall } from "../spine/stamps.js";
import type { ActorCtx } from "../types.js";

// A person's own preferences that follow them to every device they sign in
// on (actor_prefs, migration 124). They are nobody else's business and change
// no note, so they are neither events nor read-gated: each person reads and
// writes only their own rows, and the last write wins.
//
// Every key is listed here with the shape it holds; anything else is refused,
// so the table never fills with whatever a client sends.

/** The palette stores lowercase `#rrggbb` only (the picker writes it that way). */
const HEX_COLOR = z.string().refine((value) => isHexColor(value) && value === value.toLowerCase(), "must be lowercase #rrggbb");

const TOOLBAR_LAYOUT = z.object({
  bar: z.array(z.string().min(1).max(64)).max(64).nullable(),
  selection: z.array(z.string().min(1).max(64)).max(64).nullable(),
}).strict();

const SPLIT_PANE = z.object({
  right: z.string().min(1).max(200).nullable(),
  ratio: z.number().min(0.25).max(0.75),
}).strict();

const PREF_SCHEMAS = {
  /** The navigation layout (frontend lib/navLayout, 「釘到導覽列」): the
   *  destination ids in nav order, and how many of the first the phone's bar
   *  shows. Ids are the frontend's; the server only bounds their size. */
  nav: z.object({
    order: z.array(z.string().min(1).max(64)).max(64),
    phone: z.number().int().min(0).max(3),
  }).strict(),
  /** The tag list in the sidebar (frontend lib/sidebarTagsStore): the tags
   *  pinned to its top in pin order, and the tags left out of it. Ids are tag
   *  ids; the server only bounds their number and size. Neither changes a tag
   *  or who can see it. */
  sidebarTags: z.object({
    pinned: z.array(z.string().min(1).max(64)).max(200),
    hidden: z.array(z.string().min(1).max(64)).max(1000),
  }).strict(),
  /** Which buttons the editor's toolbars show, and in what order (frontend
   *  lib/toolbarLayout, lib/toolbarLayoutStore): `bar` is the phone and tablet
   *  formatting bar, `selection` the bar over selected text. Each is the ids of
   *  the buttons shown, in order (null: the default); every other button waits
   *  in 「更多」. Ids are the frontend's; the server only bounds their number
   *  and size. Changes no note. */
  toolbarLayout: TOOLBAR_LAYOUT,
  /** The paragraphs the person last copied a block link for (frontend
   *  lib/recentBlocksStore): the note id and the paragraph's ^id, newest
   *  first, with the time (ms) it was saved so two devices merge by recency.
   *  At most 10. The editor's `((` list shows them first; whether the note or
   *  paragraph still exists, and may be read, is checked when they are shown.
   *  Saving one changes no note. */
  recentBlocks: z.array(z.object({
    note: z.string().min(1).max(64),
    ref: z.string().min(1).max(64),
    at: z.number().int().positive(),
  }).strict()).max(10),
  /** One-time hints this person has already been shown (frontend
   *  hooks/useHintOnce): the hint ids, each shown at most once per account on
   *  every device. Ids are the frontend's; the server only bounds their number
   *  and size. A hint never changes a note or who can see it. */
  hintsSeen: z.array(z.string().min(1).max(64)).max(100),
  /** How far into the 「這次更新」 list (frontend lib/whatsNew, the repo's
   *  changes/ folder) the person has read: the id of the newest change seen,
   *  which starts with its day (`2026-10-29-add-view`). Only moves forward
   *  (FORWARD_ORDER, by that day). Reading the list changes no note. */
  changesSeen: z.string().regex(/^\d{4}-\d{2}-\d{2}[a-z0-9-]*$/).max(100),
  /** The note new day notes go under (frontend lib/dayNoteParentStore, 日記
   *  module): a note id, or null (cleared) for the personal space's top level.
   *  Whether the note exists is the frontend's call: a gone one counts as the
   *  top level. The choice changes no note. */
  dayNoteParent: z.string().min(1).max(64),
  /** Where a quick capture goes when the person gives no place (frontend
   *  modules/capture/captureDestination): "inbox", "today" (today's day note,
   *  while the journal is on) or the id of a note. Whether the note still
   *  exists is the frontend's call: a gone one counts as the inbox. The choice
   *  changes no note. */
  captureDestination: z.string().min(1).max(64),
  /** 「顯示未讀數字」 of the RSS reader (frontend modules/rss/rssCounts): whether
   *  the reader and the nav show how many articles are new. The person's own
   *  choice; it changes no feed or article. */
  rssShowCounts: z.boolean(),
  /** Feeds whose unread number is turned on or off against that setting
   *  (feed id → "on" | "off"). Ids are the frontend's; the server only bounds
   *  their number and size. */
  rssFeedCounts: z.record(z.string().min(1).max(64), z.enum(["on", "off"]))
    .refine((map) => Object.keys(map).length <= 500),
  /** Where the person is in each RSS view ("all" or a feed id → the article
   *  they were on and whether it was open). The frontend keeps the 50 latest
   *  views; the server refuses more, so the row cannot grow without bound. */
  rssReadingPosition: z.record(
    z.string().min(1).max(64),
    z.object({ id: z.string().min(1).max(64), open: z.boolean() }).strict(),
  ).refine((map) => Object.keys(map).length <= 50),
  /** When the person last had the RSS reader open (ISO time of the newest
   *  article they had seen): the nav dot means "articles arrived after this". */
  rssLastVisit: z.string().min(1).max(40).refine((time) => !Number.isNaN(Date.parse(time))),
  /** How long the last focus was meant to run, in minutes (frontend
   *  lib/focusStore): 0 is 「不計時」. The next focus starts with it, and the
   *  focus still running on another device counts down by it. Changes no record. */
  focusMinutes: z.number().int().min(0).max(240),
  /** 「專注／休息輪替」 (frontend lib/focus/focusCycle): after each focus round a break
   *  of `rest` minutes, and after every `longEvery`-th round the long one (0: never).
   *  The long break's length is the frontend's constant. Null reads as one focus at a
   *  time. The next focus starts with it; it changes no record, and breaks are never recorded. */
  focusCycle: z.object({ rest: z.number().int().min(1).max(60), longEvery: z.number().int().min(0).max(12) }).strict(),
  /** 「裝置時區不同時問我」 (frontend lib/timeZoneAsk): whether the owner is
   *  asked when this device's time zone differs from the workspace's. Missing
   *  or null reads as on. The person's own choice; it changes no setting. */
  timeZoneAsk: z.boolean(),
  /** The device time zone the person has already answered the question for
   *  (an IANA name): that zone is not asked about again; a different one
   *  (including the home zone on return) can be. Changes no setting. */
  timeZoneAnswered: z.string().min(1).max(64),
  /** 介面字型與內文字型 (frontend lib/fontPrefs): per role, "default" (the built-in face),
   *  "system" (the device's own) or "custom" with the family name the person typed. The name is
   *  only a name to look up on each device (one that lacks it uses the default), never a file. */
  fonts: z.object({
    ui: z.object({ mode: z.enum(["default", "system", "custom"]), name: z.string().max(80).optional() }).strict(),
    body: z.object({ mode: z.enum(["default", "system", "custom"]), name: z.string().max(80).optional() }).strict(),
  }).strict(),
  /** The ink colours the person chose (frontend lib/inkPrefs): the five quick
   *  colours the pen toolbar shows, the colours they used lately (newest first)
   *  and the ones they made. `#rrggbb` only; the lists are bounded so the row
   *  cannot grow. Changes no drawing. */
  inkPalette: z.object({
    quick: z.array(HEX_COLOR).length(5),
    recent: z.array(HEX_COLOR).max(8),
    custom: z.array(HEX_COLOR).max(12),
  }).strict(),
  /** The shape the shape button last drew (frontend lib/inkPrefs): one of the
   *  kinds the ink format offers. */
  inkShape: z.enum(INK_SHAPE_KINDS as [string, ...string[]]),
  /** 「畫完停住自動修成形狀」: whether a pen held still turns its stroke into the
   *  shape it looks like (frontend lib/inkPrefs). */
  inkAutoShape: z.boolean(),
  /** Whether new shapes get a tinted inside (frontend lib/inkPrefs). */
  inkShapeFill: z.enum(["none", "solid"]),
  /** The pen presets the person saved (frontend lib/ink/presets): a tool,
   *  a colour and a thickness each, at most six. The id only tells the list's
   *  entries apart; the name is the person's own words. */
  inkPresets: z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().max(INK_PRESET_NAME_MAX * 12.5), // 24 characters; a character can be many units (12.5 of them on average here), so only the size is bounded
    tool: z.enum(["pen", "highlighter"]),
    color: HEX_COLOR,
    sizeId: z.enum(["fine", "medium", "broad"]),
  }).strict()).max(6),
  /** A person's own cap on reviews a day (frontend modules/review/reviewCapPref,
   *  the review status page): one number, counted once across all their review
   *  cards, due and new together; cards over it are only hidden for the day.
   *  Null (cleared) reads as no cap. Changes no note and no schedule. */
  reviewsPerDay: z.number().int().min(1).max(5000),
  /** How the review status page groups cards to practise (frontend modules/review/reviewGroupPref):
   *  by tag or by note. Missing reads as by tag. Changes no note and no schedule. */
  reviewGroupBy: z.enum(["tag", "note"]),
  /** The 範圍 the review page was last set to (frontend modules/review/reviewScopePref): the page's address text
   *  (reviewPlace) of all cards, a note's subtree, a tag, or the cards under no tag. Cleared reads as all cards. Holds ids, so a
   *  temporary session does not read it. Changes no note and no schedule. */
  reviewScope: z.string().regex(new RegExp(`^(all|untagged|(root|tag)\\.${UUID_SOURCE})$`, "i")),
  /** The built-in skills (their ids, not the person's own skill notes: those
   *  keep the switch in their note) the person turned off for the AI's own
   *  picking (frontend modules/skills): off means the AI uses it only when
   *  named. Missing reads as all on. Changes no note. */
  aiSkillsOff: z.array(z.string().min(1).max(64)).max(100),
  /** The right-hand pane of the side-by-side view (frontend lib/splitView):
   *  what it shows ("note:<id>:<tab>" or "page:<mode>", null: closed) and how
   *  much width the left side keeps (a share, 0.25–0.75). Opens nothing by
   *  itself and changes no note. */
  splitPane: SPLIT_PANE,
  // The same shape kept once per kind of screen (frontend `follows: "deviceKind"`,
  // lib/accountPrefStore): a pane opened on a desktop is not the phone's. The
  // key without a suffix is no longer written; it is only what each kind starts
  // from until it has its own value.
  "splitPane.phone": SPLIT_PANE,
  "splitPane.desktop": SPLIT_PANE,
  // Same, for the editor toolbars' arrangement: a phone's bar is much narrower.
  "toolbarLayout.phone": TOOLBAR_LAYOUT,
  "toolbarLayout.desktop": TOOLBAR_LAYOUT,
} as const;

export type PrefKey = keyof typeof PREF_SCHEMAS;

/** Every key the table holds (the frontend contract test compares its own against these). */
export const PREF_KEYS = Object.keys(PREF_SCHEMAS) as PrefKey[];

export function isPrefKey(key: string): key is PrefKey {
  return Object.prototype.hasOwnProperty.call(PREF_SCHEMAS, key);
}

/** Keys that used to exist and no longer do. A frontend from before the feature
 *  was removed (a phone that still has the old page open) keeps sending them, and
 *  a refused write would leave its copy dirty and retried at every sync. So a
 *  write to one is answered as accepted but never stored, and a read finds nothing
 *  (routes/me.ts); a backup row holding one is skipped like any unknown key. */
const RETIRED_PREF_KEYS: ReadonlySet<string> = new Set([
  "journalShutdown", "journalShutdowns", // 收工, removed from the frontend 2026-11-06
]);

export function isRetiredPrefKey(key: string): boolean {
  return RETIRED_PREF_KEYS.has(key);
}

/** The value a write would store, or null when it does not fit the key's
 *  shape. `null` itself is valid: it clears the preference. */
export function parsePref(key: PrefKey, value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  const parsed = PREF_SCHEMAS[key].safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** Keys whose value only moves forward (frontend `isNewer`): the number a
 *  value is ordered by, in the same order the frontend compares. A write that
 *  is not at least as far forward as the stored one is refused. Declared here
 *  so the comparison runs inside the one UPDATE, not as a read then a write. */
const FORWARD_ORDER: Partial<Record<PrefKey, (value: unknown) => number>> = {
  rssLastVisit: (value) => Date.parse(value as string),
  // Two ids of one day tie here and fall back to the edit time.
  changesSeen: (value) => Date.parse(`${(value as string).slice(0, 10)}T00:00:00Z`),
};

/** Whether a temporary session may read the person's value of each key. Every key must say (the type), so a new preference is decided when it is
 *  added. `false` = the value holds ids of notes, tags, feeds or articles of the workspace, which may sit in a space the session cannot reach: it
 *  reads as never set, the same answer as a person who never chose. */
const SESSION_MAY_READ_PREF: Record<PrefKey, boolean> = {
  nav: true, // destination ids of the app's own pages
  sidebarTags: false, // tag ids
  toolbarLayout: true, "toolbarLayout.phone": true, "toolbarLayout.desktop": true,
  recentBlocks: false, // note ids
  hintsSeen: true, changesSeen: true,
  dayNoteParent: false, captureDestination: false, // note ids
  rssShowCounts: true,
  rssFeedCounts: false, rssReadingPosition: false, // feed and article ids
  rssLastVisit: true,
  focusMinutes: true, focusCycle: true,
  timeZoneAsk: true, timeZoneAnswered: true,
  fonts: true, inkPalette: true, inkShape: true, inkAutoShape: true, inkShapeFill: true, inkPresets: true,
  reviewsPerDay: true, reviewGroupBy: true,
  reviewScope: false, // note and tag ids
  aiSkillsOff: true, // ids of the built-in skills
  splitPane: false, "splitPane.phone": false, "splitPane.desktop": false, // "note:<id>"
};

/** The caller's stored value, or null when they never set one. A temporary session reads its person's (personalDataOwnerId), without the keys
 *  that name things of the workspace (SESSION_MAY_READ_PREF). */
export async function readPref(actor: ActorCtx, key: PrefKey): Promise<unknown> {
  if (isTemporarySessionActor(actor) && !SESSION_MAY_READ_PREF[key]) return null;
  return readPrefOf(personalDataOwnerId(actor), key);
}

/** The stored value of a person by id (a token's issuer, whose choice an agent follows). */
export async function readPrefOf(personId: string, key: PrefKey): Promise<unknown> {
  const row = await q<{ value: unknown }>("SELECT value FROM actor_prefs WHERE actor_id = $1 AND key = $2", [personId, key]);
  return row.rows[0]?.value ?? null;
}

/** Store the caller's value (already parsed by parsePref); null removes it.
 *  Without `editAgeMs` the write is unconditional, last write wins. With it (how
 *  long before this request the device made the edit, from the device's own
 *  clock: the route turns an older frontend's `editedAt` into it, clientClock.ts)
 *  the edit is dated on the write's own logical clock, the stamp of its transaction
 *  (spine/stamps.ts), minus that age, and applied only when no later edit is
 *  stored; a "moves forward" key is instead
 *  applied only when its value is not behind the stored one. Decided in one
 *  statement, so two devices writing at once cannot overwrite each other with
 *  an older value. Returns what the account holds afterwards. */
export async function writePref(
  actor: ActorCtx, key: PrefKey, value: unknown, editAgeMs?: number,
): Promise<{ applied: boolean; value: unknown }> {
  const workspaceId = await getWorkspaceId();
  return mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }) => {
    const editedAt = editAgeMs === undefined ? undefined : (await currentStampWall(workspaceId) ?? Date.now()) - editAgeMs;
    return writePrefStamped(current, key, value, editedAt);
  } });
}

async function writePrefStamped(
  actor: ActorCtx, key: PrefKey, value: unknown, editedAt: number | undefined,
): Promise<{ applied: boolean; value: unknown }> {
  if (editedAt === undefined) {
    if (value === null) {
      await q("DELETE FROM actor_prefs WHERE actor_id = $1 AND key = $2", [actor.id, key]);
      return { applied: true, value: null };
    }
    const order = FORWARD_ORDER[key]?.(value) ?? null;
    // A forward key still never moves back: a dirty copy an older frontend saved
    // before the upgrade has no edit time, and must not roll a newer value back.
    const done = await q(
      `INSERT INTO actor_prefs (actor_id, key, value, updated_at, order_key) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (actor_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), order_key = EXCLUDED.order_key
       ${order === null ? "" : "WHERE actor_prefs.order_key IS NULL OR actor_prefs.order_key <= EXCLUDED.order_key"}
       RETURNING 1`,
      [actor.id, key, JSON.stringify(value), order],
    );
    if (done.rowCount) return { applied: true, value };
    return { applied: false, value: await readPref(actor, key) };
  }
  const order = value === null ? null : FORWARD_ORDER[key]?.(value) ?? null;
  // A forward key is judged by its value, a tie (the same day's 收工 from two
  // devices) by edit time; a reset (and every other key) by edit time alone.
  const byEditTime = "actor_prefs.edited_at IS NULL OR actor_prefs.edited_at <= EXCLUDED.edited_at";
  const guard = order === null
    ? byEditTime
    : `actor_prefs.order_key IS NULL OR actor_prefs.order_key < EXCLUDED.order_key
       OR (actor_prefs.order_key = EXCLUDED.order_key AND (${byEditTime}))`;
  const done = await q(
    `INSERT INTO actor_prefs (actor_id, key, value, updated_at, edited_at, order_key)
     VALUES ($1, $2, $3, now(), to_timestamp($4::float8 / 1000.0), $5)
     ON CONFLICT (actor_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now(), order_key = EXCLUDED.order_key,
           edited_at = GREATEST(actor_prefs.edited_at, EXCLUDED.edited_at)
       WHERE ${guard}
     RETURNING 1`,
    [actor.id, key, value === null ? null : JSON.stringify(value), editedAt, order],
  );
  if (done.rowCount) return { applied: true, value };
  return { applied: false, value: await readPref(actor, key) };
}
