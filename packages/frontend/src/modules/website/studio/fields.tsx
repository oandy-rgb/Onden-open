// The properties panel's own fields: which note or tag a block points at, how
// much of it shows. They draw their own <label for>, so none
// sets a Puck label (Puck would wrap the whole control in a second <label>). The design stores ids; these let the
// owner choose them by name. Content is shown read-only with 「到筆記裡改」: a
// note's words are only ever changed in the note.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createUsePuck, type Field } from "@puckeditor/core";
import { extractBlock, cutToUnits } from "@onden/markdown";
import { anchorSpansOf } from "../../../lib/blockAnchorStore";
import { useStudioData, type SavedViewChoice } from "./studioContext";
import { useT } from "../../../lib/i18n";
import { displayTitle } from "../../../lib/noteLabel";
import { containsTitle } from "../../../lib/noteSearch";
import EmptyState from "../../../components/EmptyState";
import { Chip, Pressable, Segmented, Select, TextArea, TextField, SearchField } from "../../../components/ui";

const usePuck = createUsePuck();
const LIST_MAX = 50;
const PREVIEW_CHARS = 160;

/** Change several props of the selected component at once (a view choice sets
 *  `viewId` and `viewKind` together; Puck's field onChange sets one prop). */
function useSelectedProps() {
  const item = usePuck((s) => s.selectedItem);
  const getSelectorForId = usePuck((s) => s.getSelectorForId);
  const dispatch = usePuck((s) => s.dispatch);
  return {
    props: (item?.props ?? {}) as Record<string, unknown>,
    set: (patch: Record<string, unknown>) => {
      if (!item) return;
      const selector = getSelectorForId(item.props.id);
      if (!selector) return;
      dispatch({
        type: "replace", destinationIndex: selector.index, destinationZone: selector.zone,
        data: { ...item, props: { ...item.props, ...patch } },
      });
    },
  };
}

function FieldBox({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="hs-field">
      <label className="hs-field__label" htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

/** A search box over a list of {id, label}; choosing one calls `onPick`. */
function Picker({ label, items, selectedId, onPick, emptyText, extra }: {
  label: string;
  items: readonly { id: string; label: string; note?: string }[];
  selectedId: string;
  onPick: (id: string) => void;
  emptyText: string;
  extra?: ReactNode;
}) {
  const t = useT();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const selected = items.find((item) => item.id === selectedId);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle ? items.filter((item) => containsTitle(needle, item.label)) : items;
    return matches.slice(0, LIST_MAX);
  }, [items, query]);
  return (
    <FieldBox label={label} htmlFor={inputId}>
      <p className="hs-field__current" data-empty={selected ? undefined : ""}>
        {selected ? displayTitle(selected.label) : selectedId ? t("Can't find this item") : t("Not chosen yet")}
      </p>
      <SearchField id={inputId} label={t("Search…")} value={query} onValueChange={setQuery} />
      <ul className="hs-pick-list">
        {shown.map((item) => (
          <li key={item.id}>
            <Pressable type="button" className="hs-pick" aria-pressed={item.id === selectedId} onClick={() => onPick(item.id)}>
              <span>{displayTitle(item.label)}</span>
              {item.note ? <span className="hs-pick__note">{item.note}</span> : null}
            </Pressable>
          </li>
        ))}
        {shown.length === 0 ? <EmptyState size="inline" as="li" title={emptyText} /> : null}
      </ul>
      {extra}
    </FieldBox>
  );
}

// ── Note ─────────────────────────────────────────────────────────────────

type NoteFilter = "all" | "published" | "unpublished";

/** The note's date as the list shows it: the day of its last edit. */
const dayOf = (iso: string) => iso.slice(0, 10);

function NoteFieldBody({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useT();
  const data = useStudioData();
  const { props } = useSelectedProps();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<NoteFilter>("all");
  const counts = useMemo(() => {
    const published = data.notes.filter((n) => n.published).length;
    return { all: data.notes.length, published, unpublished: data.notes.length - published };
  }, [data.notes]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.notes
      .filter((n) => filter === "all" || (filter === "published") === n.published)
      .filter((n) => needle === "" || containsTitle(needle, n.title))
      .slice(0, LIST_MAX);
  }, [data.notes, query, filter]);
  const selected = data.notes.find((n) => n.id === value);
  const markdown = value ? data.markdownOf(value) : null;
  const blockId = typeof props.blockId === "string" ? props.blockId : "";
  const excerpt = markdown === null || !value ? null : cutToUnits(((blockId && extractBlock(markdown, blockId, anchorSpansOf(value, markdown))) || markdown).trim(), PREVIEW_CHARS);
  const filters: ReadonlyArray<{ value: NoteFilter; label: string }> = [
    { value: "all", label: t("All") },
    { value: "published", label: `${t("Published")} ${counts.published}` },
    { value: "unpublished", label: `${t("Not published")} ${counts.unpublished}` },
  ];
  return (
    <FieldBox label="筆記" htmlFor={inputId}>
      <p className="hs-field__current" data-empty={selected ? undefined : ""}>
        {selected ? displayTitle(selected.title) : value ? t("Can't find this note") : t("Not chosen yet")}
      </p>
      <Segmented className="hs-filters" label="篩選筆記" value={filter} options={filters} onChange={setFilter} />
      <SearchField id={inputId} label={t("Search…")} value={query} onValueChange={setQuery} />
      <ul className="hs-pick-list">
        {shown.map((n) => (
          <li key={n.id}>
            <Pressable type="button" className="hs-pick" aria-pressed={n.id === value} onClick={() => onChange(n.id)}>
              <span className="hs-pick__title">{displayTitle(n.title)}</span>
              <span className="hs-pick__meta">
                {n.updatedAt ? <time dateTime={n.updatedAt}>{dayOf(n.updatedAt)}</time> : null}
                <Chip tone={n.published ? "accent" : "neutral"}>{n.published ? t("Published") : t("Not published")}</Chip>
              </span>
            </Pressable>
          </li>
        ))}
        {shown.length === 0 ? <EmptyState size="inline" as="li" title="沒有符合的筆記" /> : null}
      </ul>
      {selected && !selected.published && (
        <div className="hs-publish-this">
          <Pressable type="button" className="hs-button hs-button--primary" onClick={() => data.publishNote(selected.id)}>發布這篇</Pressable>
          <p className="hs-hint">這篇還沒發布，網站上這一格先顯示標題。按上方的「發布」之後，訪客就看得到內容。</p>
        </div>
      )}
      {selected && (
        <div className="hs-readonly">
          <p className="hs-readonly__text" aria-label="筆記內容（唯讀）">{excerpt === null ? "載入中…" : excerpt === "" ? "這篇筆記沒有內文。" : excerpt}</p>
          <Pressable type="button" className="hs-link" onClick={() => data.openNote(selected.id)}>到筆記裡改</Pressable>
          {selected.published && <Pressable type="button" className="hs-link" onClick={() => data.unpublishNote(selected.id)}>從網站移除</Pressable>}
        </div>
      )}
    </FieldBox>
  );
}

export const noteField: Field = {
  type: "custom",
  render: ({ value, onChange }) => <NoteFieldBody value={value ?? ""} onChange={onChange} />,
};

// ── How much of the note shows ───────────────────────────────────────────

const DISPLAY_CHOICES = [
  { value: "full", label: "整篇" },
  { value: "first", label: "摘要" },
  { value: "title", label: "只有標題" },
] as const;

function DisplayFieldBody({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  // A card (the 圖文卡片 block, the 三欄入口 pattern) is a fourth look; it is offered only while the block is one.
  const choices = value === "card" ? [...DISPLAY_CHOICES, { value: "card", label: "圖文卡片" }] : DISPLAY_CHOICES;
  return (
    <FieldBox label="顯示方式">
      <Segmented className="hs-filters" label="顯示方式" value={value} options={choices} onChange={onChange} />
    </FieldBox>
  );
}

export const displayField: Field = {
  type: "custom",
  render: ({ value, onChange }) => <DisplayFieldBody value={value ?? "full"} onChange={onChange} />,
};

// ── an anchored paragraph of the chosen note ─────────────────────────────────────

function BlockFieldBody({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const data = useStudioData();
  const { props } = useSelectedProps();
  const noteId = typeof props.noteId === "string" ? props.noteId : "";
  const markdown = noteId ? data.markdownOf(noteId) : null;
  const blocks = useMemo(() => {
    if (!markdown) return [];
    const spans = anchorSpansOf(noteId, markdown);
    return spans.flatMap((anchor) => {
      const text = extractBlock(markdown, anchor.id, spans);
      return text ? [{ id: anchor.id, label: cutToUnits(text.replace(/\s+/g, " "), 60) }] : [];
    });
  }, [noteId, markdown]);
  // Only a note that already has paragraph anchors offers them.
  if (blocks.length === 0) return null;
  const items = [{ id: "", label: "整篇筆記" }, ...blocks];
  return <Picker label="只放其中一段" items={items} selectedId={value} onPick={onChange} emptyText="沒有符合的段落" />;
}

export const blockField: Field = {
  type: "custom",
  render: ({ value, onChange }) => <BlockFieldBody value={value ?? ""} onChange={onChange} />,
};

// ── Tag ──────────────────────────────────────────────────────────────────

function TagFieldBody({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const data = useStudioData();
  const items = useMemo(() => data.tags.map((tag) => ({ id: tag.id, label: tag.name, note: `${tag.memberCount} 篇` })), [data.tags]);
  return <Picker label="標籤" items={items} selectedId={value} onPick={onChange} emptyText="沒有符合的標籤" />;
}

export const tagField: Field = {
  type: "custom",
  render: ({ value, onChange }) => <TagFieldBody value={value ?? ""} onChange={onChange} />,
};

// ── The tag's saved views ────────────────────────────────────────────────

function ViewFieldBody({ value }: { value: string }) {
  const data = useStudioData();
  const { props, set } = useSelectedProps();
  const tagId = typeof props.tagId === "string" ? props.tagId : "";
  const selectId = useId();
  const [views, setViews] = useState<SavedViewChoice[]>([]);
  useEffect(() => {
    let live = true;
    setViews([]);
    if (tagId) void data.savedViews(tagId).then((list) => { if (live) setViews(list); }, () => {});
    return () => { live = false; };
  }, [tagId, data]);
  if (!tagId || views.length === 0) return null;
  return (
    <FieldBox label="檢視" htmlFor={selectId}>
      <Select
        id={selectId} className="hs-input" value={value}
        onChange={(e) => {
          const view = views.find((v) => v.id === e.target.value);
          set(view ? { viewId: view.id, viewKind: view.kind } : { viewId: "" });
        }}
      >
        <option value="">標籤預設</option>
        {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </Select>
    </FieldBox>
  );
}

export const viewField: Field = {
  type: "custom",
  render: ({ value }) => <ViewFieldBody value={value ?? ""} />,
};

// ── 進階: class name and this part's CSS, collapsed ──────────────────────

function AdvancedBody() {
  const { props, set } = useSelectedProps();
  const clsId = useId();
  const cssId = useId();
  const cls = typeof props.cls === "string" ? props.cls : "";
  const css = typeof props.css === "string" ? props.css : "";
  return (
    <details className="hs-advanced">
      <summary>進階</summary>
      <FieldBox label="class 名稱" htmlFor={clsId}>
        <TextField id={clsId} className="hs-input" value={cls} maxLength={60} onChange={(e) => set({ cls: e.target.value })} />
      </FieldBox>
      <FieldBox label="只作用在這個零件的 CSS" htmlFor={cssId}>
        <TextArea id={cssId} className="hs-input hs-input--code" rows={5} spellCheck={false} value={css} onChange={(e) => set({ css: e.target.value })} />
      </FieldBox>
    </details>
  );
}

export const advancedField: Field = {
  type: "custom",
  render: () => <AdvancedBody />,
};
