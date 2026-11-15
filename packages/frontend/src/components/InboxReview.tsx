import type { InboxFilters } from "../lib/inboxFilters";
import { SLIDES_DATA_ATTR, isInkPageAttr } from "@onden/markdown";
import { useEffect, useMemo, useState } from "react";
import { useAutoReset } from "../hooks/useTransientFlag";
import { Check, Undo2, Ban, Bot, FilePlus2, Globe, Pencil, Trash2, RotateCcw, Tag, SlidersHorizontal, ChevronDown, X } from "lucide-react";
import { ApiError, type InboxEvent, type InboxFacets, type InboxGroup, type PendingApproval } from "../lib/api";

import { t, useT } from "../lib/i18n";
import { useNode } from "../lib/appStore";
import { displayTitle } from "../lib/noteLabel";
import { agentLabel, aiLabel } from "../lib/actorLabel";
import { dedupedGet, reads } from "../lib/data";
import { describeInkValueChange } from "../lib/pdf";
import { useCanReview } from "../lib/capabilities";
import "./InboxReview.css";
import "../styles/event-kinds.css";
import { eventKindClass, eventTypeLabel, eventVerb } from "../lib/eventKinds";
import { effectKindLabel } from "../lib/effectKinds";
import FailedJobsNotice from "./FailedJobsNotice";
import { relTime } from "../lib/timeLabels";
import { Chip, Pressable, Select } from "./ui";
import EmptyState from "./EmptyState";
import { TextCompare } from "./compare";

// D7 governance review surface. The inbox holds only what waits for a
// decision; the sidebar pane adds the edit conflicts below it. TWO card kinds
// by risk tier:
//
//   • HELD EFFECTS (approve-BEFORE-apply): outbound/irreversible requests the
//     agent filed but that have NOT run (today: installing a tag pack). Approve
//     runs it; Reject buries it — nothing happened either way until you decide.
//     These sit on top: they're the queue's only true blockers.
//   • APPLIED CHANGES (apply-then-review): reversible agent edits, already
//     applied, surfaced for after-the-fact review. Approve keeps; Reject runs
//     the event's inverse-undo (backend cascade).
//
// Each card is a DECISION surface, not just a notification — it carries the
// EVIDENCE (what changed / what would run) so the human can judge without
// leaving, per the agentic-AI approval-UX research.

const ICON: Record<string, typeof Bot> = {
  NODE_CREATED: FilePlus2, NODE_UPDATED: Pencil, NODE_DELETED: Trash2,
  NODE_RESTORED: RotateCcw, TAG_APPLIED: Tag, TAG_REMOVED: Tag,
  ATTRIBUTE_SET: SlidersHorizontal, ATTRIBUTE_DELETED: SlidersHorizontal,
};

/** The note an event is about, as the card names it: the title the event recorded, else the note's title now
 *  (an event that records none, like an AI's suggestion), else a plain "a note". */
function EventNoteTitle({ e }: { e: InboxEvent }) {
  const note = useNode(e.target_id);
  return <>{(e.payload?.title as string) || (note ? displayTitle(note.title) : t("a note"))}</>;
}

// Restore-preview shape (GET /api/events/:id/preview) — the inverse the reject
// would produce. For an edit, current_body = post-agent, restored_body = the
// body reject reverts to, so their diff IS the agent's change.
type Preview =
  | { kind: "node_update"; current_body: string; restored_body: string; can_apply_cleanly: boolean }
  | { kind: string; [k: string]: unknown };

// Inline evidence for ONE card. Edits lazy-fetch the diff; tag/attr render from
// the event payload (no fetch); creates link out to the new note.
function Evidence({ e, onOpenNode }: { e: InboxEvent; onOpenNode?: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  // A failed read must not look like a diff that is still loading.
  // "gone": the server answered that the target no longer exists, which a retry cannot change.
  const [previewFailed, setPreviewFailed] = useState<"gone" | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const isEdit = e.event_type === "NODE_UPDATED";
  const isAttr = e.event_type === "ATTRIBUTE_SET" || e.event_type === "ATTRIBUTE_DELETED";
  // Ink changes need the BEFORE value to show the gesture — same preview
  // fetch the body diff uses (restored_value = pre-change).
  const isInk = isAttr && isInkPageAttr(e.payload?.key as string);

  useEffect(() => {
    if (!isEdit && !isInk) return;
    let live = true;
    reads.events.preview<{ preview?: Preview }>(e.id)
      .then((r) => { if (live && r.preview) { setPreview(r.preview); setPreviewFailed(null); } })
      .catch((error) => { if (live) setPreviewFailed(error instanceof ApiError && (error.status === 404 || error.status === 410) ? "gone" : "failed"); }); // the card stays reviewable without the diff
    return () => { live = false; };
  }, [e.id, isEdit, isInk, attempt]);
  const retryPreview = () => { setPreviewFailed(null); setAttempt((n) => n + 1); };
  const previewError = previewFailed === "gone"
    ? <span className="inbox-ev-muted">{t("This note is no longer there.")}</span>
    : (
      <span className="inbox-ev-muted">
        {t("Couldn't load this change.")}{" "}
        <Pressable type="button" className="inbox-ev-link" onClick={retryPreview}>{t("Try again")}</Pressable>
      </span>
    );

  if (e.event_type === "NODE_CREATED") {
    return onOpenNode
      ? <Pressable className="inbox-ev-link" onClick={() => onOpenNode(e.target_id)}>{t("View the new note →")}</Pressable>
      : <span className="inbox-ev-muted">{t("a new note")}</span>;
  }
  if (e.event_type === "TAG_APPLIED" || e.event_type === "TAG_REMOVED") {
    const tagName = (e.payload?.tag_name as string) || t("tag");
    return <Chip>#{tagName}</Chip>;
  }
  if (isInk) {
    // The gesture, not the schema: "p.1: drew 2 strokes, erased 1 span".
    if (!preview && previewFailed) return previewError;
    if (!preview || preview.kind !== "attribute_change") return <span className="inbox-ev-muted">{t("loading drawing change…")}</span>;
    const p = preview as unknown as { current_value: string | null; restored_value: string | null };
    return <Chip>✎ {describeInkValueChange(p.restored_value, p.current_value)}</Chip>;
  }
  if (isAttr && e.payload?.key === SLIDES_DATA_ATTR) return <Chip>{t("Slides changed")}</Chip>;
  if (isAttr) {
    const k = (e.payload?.key as string) || t("field");
    const v = e.payload?.value as string | undefined;
    // Long values (docs, JSON blobs) would dump schema into the card — name
    // the field, skip the payload.
    const short = v != null && v.length <= 60 ? ` = ${v}` : v != null ? ` ${t("changed")}` : "";
    return <Chip>{k}{short}</Chip>;
  }
  if (isEdit) {
    if (!preview && previewFailed) return previewError;
    if (!preview || preview.kind !== "node_update") return <span className="inbox-ev-muted">{t("loading change…")}</span>;
    const p = preview as { restored_body: string; current_body: string; can_apply_cleanly: boolean };
    const changed = p.restored_body !== p.current_body;
    return (
      <div className="inbox-ev">
        <Pressable className="inbox-ev-summary" onClick={() => setOpen((o) => !o)} title={t("Show what changed")}>
          <ChevronDown size={11} className={open ? "inbox-ev-chev open" : "inbox-ev-chev"} />
          <span className={changed ? "" : "inbox-ev-muted"}>{changed ? t("Text changed") : t("no body change")}</span>
          {!p.can_apply_cleanly && <span className="inbox-ev-warn" title={t("The text changed again after this, so sending it back may not apply cleanly")}>{t("diverged")}</span>}
        </Pressable>
        {open && changed && (
          <div className="inbox-ev-diff">
            <TextCompare before={p.restored_body} after={p.current_body} beforeLabel={t("Before")} afterLabel={t("After")} layout="single" />
          </div>
        )}
      </div>
    );
  }
  return null;
}

// P1 governance: what ELSE a reject would restore. The triggered_by
// descendants of this event (dispatcher cascades, template children) are
// invisible on the card otherwise — a reject is a CASCADE inverse-undo, so
// the human must see the blast radius before arming it. Lazy, deduped fetch;
// renders nothing for cascade-free events (the common case stays quiet).
type CascadePreview = {
  count: number;
  /** Whole chain the undo would walk (the list above is capped); absent from older servers. */
  total?: number;
  truncated: boolean;
  events: Array<{ id: string; event_type: string; title: string | null; redacted: boolean }>;
};

/** Undoing more changes than this holds the workspace's writes for seconds (~9 ms each), so say so first. */
export const CASCADE_WAIT_HINT_MIN_CHANGES = 200;

function CascadeNotice({ eventId }: { eventId: string }) {
  const t = useT();
  const [preview, setPreview] = useState<CascadePreview | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    dedupedGet<CascadePreview>(`/api/events/${eventId}/cascade-preview`, { ttlMs: 30_000 })
      .then((p) => { if (live) setPreview(p); })
      .catch(() => { /* preview is advisory — the card stays usable */ });
    return () => { live = false; };
  }, [eventId]);
  if (!preview || preview.count === 0) return null;
  const bigUndo = (preview.total ?? preview.count) > CASCADE_WAIT_HINT_MIN_CHANGES;
  return (
    <div className="inbox-ev inbox-cascade">
      {bigUndo && <p className="inbox-ev-warn inbox-cascade-wait">{t("This undoes a lot of changes and may take a few seconds. Other edits will save a little later.")}</p>}
      <Pressable className="inbox-ev-summary" onClick={() => setOpen((o) => !o)} title={t("Rejecting also restores these triggered changes")}>
        <ChevronDown size={11} className={open ? "inbox-ev-chev open" : "inbox-ev-chev"} />
        <span className="inbox-ev-warn">{t("reject also restores {n} triggered change(s)", { n: preview.count })}{preview.truncated ? "+" : ""}</span>
      </Pressable>
      {open && (
        <ul className="inbox-cascade-list">
          {preview.events.map((ev) => (
            <li key={ev.id} className="inbox-group-member">
              <span className="inbox-group-member-type">{eventVerb(ev.event_type).toLowerCase()}</span>
              <span className="inbox-group-member-title">{ev.redacted ? t("(restricted item)") : (ev.title ?? eventTypeLabel(ev.event_type))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// What a held effect would DO, in plain words.
function describeHeld(a: PendingApproval): { what: string; detail: string } {
  if (a.effect_kind === "tag_pack") {
    const pack = (a.payload?.pack ?? {}) as { name?: string; fields?: unknown[] };
    return {
      what: t("Install tag pack #{name}", { name: pack.name ?? "?" }),
      detail: t("{n} field(s) — installs only if you approve", { n: (pack.fields ?? []).length }),
    };
  }
  return { what: effectKindLabel(a.effect_kind), detail: t("an outbound effect requested by the agent") };
}

// One batch card: events sharing a triggered_by root (a tag cascade, an
// agent's multi-step change, …) collapsed to a single decision surface with
// approve-all / dismiss-all. The member list expands on demand. (Feed
// arrivals never land here: new articles wait in Reading › RSS, which is
// not something to approve.)
function GroupCard({ group, events, busyId, online, canReview, onGroupDecide }: {
  group: InboxGroup;
  events: InboxEvent[];
  busyId: string | null;
  online: boolean;
  canReview: boolean;
  onGroupDecide: (rootEventId: string, decision: "approve" | "reject") => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const who = agentLabel(group.actor_name);
  const headline = t("{who}: {n} related changes", { who, n: group.count });
  const members = events.filter((e) => group.event_ids.includes(e.id));
  const Icon = Bot;
  const busy = busyId === group.root_event_id;

  return (
    <li className="inbox-review-item inbox-review-item-group">
      <div className="inbox-review-top">
        <span className="inbox-review-icon"><Icon size={13} /></span>
        <span className="inbox-review-desc"><span className="inbox-review-verb">{headline}</span></span>
      </div>
      <div className="inbox-review-meta">
        <span className="inbox-review-actor"><Bot size={10} /> {who}</span>
        <time className="inbox-review-time">{relTime(group.latest_created_at)}</time>
      </div>
      {group.sample_titles.length > 0 && (
        <Pressable className="inbox-group-toggle" onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={11} className={open ? "inbox-ev-chev open" : "inbox-ev-chev"} />
          {group.sample_titles.slice(0, 2).join(" · ")}{group.count > 3 ? " · …" : ""}
        </Pressable>
      )}
      {open && (
        <ul className="inbox-group-members">
          {members.map((m) => (
            <li key={m.id} className="inbox-group-member">
              <span className="inbox-group-member-type">{eventVerb(m.event_type).toLowerCase()}</span>
              <span className="inbox-group-member-title"><EventNoteTitle e={m} /></span>
            </li>
          ))}
          {members.length < group.count && (
            <li className="inbox-group-member inbox-ev-muted">{t("…{n} more", { n: group.count - members.length })}</li>
          )}
        </ul>
      )}
      {canReview && <div className="inbox-review-actions">
        <Pressable
          className="inbox-review-approve"
          disabled={!online || busy}
          onClick={() => onGroupDecide(group.root_event_id, "approve")}
          title={t("Keep everything in this batch")}
        >
          <Check size={13} /> {t("Approve all")}
        </Pressable>
        <Pressable
          className="inbox-review-reject"
          disabled={!online || busy}
          onClick={() => onGroupDecide(group.root_event_id, "reject")}
          title={t("Undo the whole batch")}
        >
          <Ban size={13} /> {t("Dismiss all")}
        </Pressable>
      </div>}
    </li>
  );
}

// The filter bar: actor chips with counts + a type dropdown, fed by the
// server's facet counts (computed BEFORE narrowing, so a chip shows what
// selecting it yields). Quiet by default — hidden until there's something
// to filter by (more than one actor or type in the queue).
function FilterBar({ facets, filters, onChange }: {
  facets: InboxFacets;
  filters: InboxFilters;
  onChange: (f: InboxFilters) => void;
}) {
  const t = useT();
  const hasFilters = !!(filters.actorId || filters.eventType);
  if (!hasFilters && facets.by_actor.length <= 1 && facets.by_type.length <= 1) return null;
  return (
    <div className="inbox-filter-bar">
      {facets.by_actor.map((a) => (
        <Pressable
          key={a.actor_id}
          className={filters.actorId === a.actor_id ? "inbox-filter-chip active" : "inbox-filter-chip"}
          onClick={() => onChange({ ...filters, actorId: filters.actorId === a.actor_id ? null : a.actor_id })}
        >
          {agentLabel(a.actor_name)} <span className="inbox-filter-count">{a.count}</span>
        </Pressable>
      ))}
      {facets.by_type.length > 1 && (
        <Select
          className="inbox-filter-type"
          value={filters.eventType ?? ""}
          onChange={(e) => onChange({ ...filters, eventType: e.target.value || null })}
        >
          <option value="">{t("All kinds")}</option>
          {facets.by_type.map((ft) => (
            <option key={ft.event_type} value={ft.event_type}>
              {eventVerb(ft.event_type)} ({ft.count})
            </option>
          ))}
        </Select>
      )}
      {hasFilters && (
        <Pressable className="inbox-filter-clear" onClick={() => onChange({ actorId: null, eventType: null })} title={t("Clear filters")}>
          <X size={11} /> {t("clear")}
        </Pressable>
      )}
    </div>
  );
}

export type { InboxReviewProps } from "../hooks/sidebarInboxTypes";
import type { InboxReviewProps } from "../hooks/sidebarInboxTypes";

export default function InboxReview({
  events, groups = [], facets, filters, onFiltersChange,
  approvals = [], busyId, online,
  onApprove, onReject, onGroupDecide, onBatchDecide, onDecideHeld, onOpenNode, showFailedJobs = true,
}: InboxReviewProps) {
  const t = useT();
  // Deciding is for the people the server lets decide (reviewAuthority); the
  // rest still read the queue. Held approvals only reach those people anyway.
  const canReview = useCanReview();
  // Bulk reject is a mass inverse-undo — destructive enough to need a second
  // click. Arm on first click, fire on the second, disarm after a beat.
  const [bulkArmed, setBulkArmed] = useState(false);
  useAutoReset(bulkArmed, () => setBulkArmed(false), 5000);
  // The card whose Reject was pressed: busyId alone does not say which button it was.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  // Events covered by a rendered batch card don't ALSO render individually.
  const groupedIds = useMemo(() => {
    const set = new Set<string>();
    if (onGroupDecide) for (const g of groups) for (const id of g.event_ids) set.add(id);
    return set;
  }, [groups, onGroupDecide]);
  const singles = events.filter((e) => !groupedIds.has(e.id));
  const hasFilterState = !!(filters && (filters.actorId || filters.eventType));
  // Failed background jobs are not approvals: they are listed in Settings ›
  // System status. The owner gets one line pointing there (nothing otherwise).
  const failedJobs = showFailedJobs ? <FailedJobsNotice online={online} /> : null;
  if (events.length === 0 && approvals.length === 0 && !hasFilterState) {
    return <section className="inbox-review">{failedJobs}</section>;
  }
  return (
    <section className="inbox-review">
      {failedJobs}
      {approvals.length > 0 && (
        <>
          <header className="inbox-review-head inbox-review-head-held">
            <Globe size={13} />
            <span className="inbox-review-title">{t("Waiting for your approval")}</span>
            <span className="inbox-review-count">{approvals.length}</span>
          </header>
          <ul className="inbox-review-list">
            {approvals.map((a) => {
              const d = describeHeld(a);
              return (
                <li key={`held-${a.id}`} className="inbox-review-item inbox-review-item-held">
                  <div className="inbox-review-top">
                    <span className="inbox-review-icon"><Globe size={13} /></span>
                    <span className="inbox-review-desc"><span className="inbox-review-verb">{d.what}</span></span>
                  </div>
                  <div className="inbox-review-meta">
                    <span className="inbox-review-actor"><Bot size={10} /> {t("requested by AI")}</span>
                    <time className="inbox-review-time">{relTime(a.created_at)}</time>
                  </div>
                  <span className="inbox-ev-muted">{t("Hasn’t run yet —")} {d.detail}.</span>
                  {canReview && <div className="inbox-review-actions">
                    <Pressable
                      className="inbox-review-approve"
                      disabled={!online || busyId === a.id}
                      onClick={() => onDecideHeld?.(a.id, "approve")}
                      title={t("Run it now")}
                    >
                      <Check size={13} /> {t("Approve & run")}
                    </Pressable>
                    <Pressable
                      className="inbox-review-reject"
                      disabled={!online || busyId === a.id}
                      onClick={() => onDecideHeld?.(a.id, "reject")}
                      title={t("It never runs")}
                    >
                      <Ban size={13} /> {t("Reject")}
                    </Pressable>
                  </div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {events.length === 0 && !hasFilterState ? null : (
      <>
      <header className="inbox-review-head">
        <Bot size={13} />
        <span className="inbox-review-title">{t("Agent changes awaiting review")}</span>
        <span className="inbox-review-count">{events.length}</span>
      </header>
      {facets && filters && onFiltersChange && (
        <FilterBar facets={facets} filters={filters} onChange={onFiltersChange} />
      )}
      {events.length === 0 && hasFilterState && (
        <EmptyState size="inline" title={t("Nothing matches these filters.")} />
      )}
      {!canReview && events.length > 0 && (
        <p className="inbox-ev-muted inbox-review-readonly">{t("Only the workspace owner or a reviewer can approve or reject these.")}</p>
      )}
      {canReview && onBatchDecide && singles.length > 1 && (
        <div className="inbox-bulk-bar">
          <span className="inbox-bulk-label">{t("{n} shown", { n: singles.length })}</span>
          <Pressable
            className="inbox-bulk-btn inbox-bulk-approve"
            disabled={!online || busyId === "batch"}
            onClick={() => { setBulkArmed(false); onBatchDecide(singles.map((s) => s.id), "approve"); }}
            title={t("Keep every change shown above")}
          >
            <Check size={12} /> {t("Approve all")}
          </Pressable>
          {bulkArmed ? (
            <Pressable
              className="inbox-bulk-btn inbox-bulk-reject armed"
              disabled={!online || busyId === "batch"}
              onClick={() => {
                setBulkArmed(false);
                onBatchDecide(singles.filter((s) => s.restorable).map((s) => s.id), "reject");
              }}
              title={t("This undoes every listed change")}
            >
              <Undo2 size={12} /> {t("Undo {n} — sure?", { n: singles.filter((s) => s.restorable).length })}
            </Pressable>
          ) : (
            <Pressable
              className="inbox-bulk-btn inbox-bulk-reject"
              disabled={!online || busyId === "batch" || singles.every((s) => !s.restorable)}
              onClick={() => setBulkArmed(true)}
              title={t("Put back every change that can be undone here — asks once more")}
            >
              <Undo2 size={12} /> {t("Reject all")}
            </Pressable>
          )}
        </div>
      )}
      <ul className="inbox-review-list">
        {onGroupDecide && groups.map((g) => (
          <GroupCard
            key={`group-${g.root_event_id}`}
            group={g}
            events={events}
            busyId={busyId}
            online={online}
            canReview={canReview}
            onGroupDecide={onGroupDecide}
          />
        ))}
        {singles.map((e) => {
          const Icon = ICON[e.event_type] ?? Bot;
          const verb = eventVerb(e.event_type);
          return (
            <li key={e.id} className={`inbox-review-item ${eventKindClass(e.event_type)}`}>
              <div className="inbox-review-top">
                <span className="inbox-review-icon"><Icon size={13} /></span>
                <span className="inbox-review-desc">
                  <span className="inbox-review-verb">{verb}</span>{" "}
                  <span className="inbox-review-target">“<EventNoteTitle e={e} />”</span>
                </span>
              </div>
              <div className="inbox-review-meta">
                <span className="inbox-review-actor"><Bot size={10} /> {aiLabel()}</span>
                <time className="inbox-review-time">{relTime(e.created_at)}</time>
              </div>
              <Evidence e={e} onOpenNode={onOpenNode} />
              <CascadeNotice eventId={e.id} />
              {canReview && <div className="inbox-review-actions">
                <Pressable
                  className="inbox-review-approve"
                  disabled={!online || busyId === e.id}
                  onClick={() => onApprove(e.id)}
                  title={t("Keep this change")}
                >
                  <Check size={13} /> {t("Approve")}
                </Pressable>
                <Pressable
                  className="inbox-review-reject"
                  disabled={!online || busyId === e.id || !e.restorable}
                  onClick={() => { setRejectingId(e.id); onReject(e.id); }}
                  title={e.restorable ? t("Undo this change") : t("Can't be auto-undone (external side effect) — approve to acknowledge")}
                >
                  <Undo2 size={13} /> {busyId === e.id && rejectingId === e.id ? t("Undoing…") : t("Reject")}
                </Pressable>
              </div>}
            </li>
          );
        })}
      </ul>
      </>
      )}
    </section>
  );
}
