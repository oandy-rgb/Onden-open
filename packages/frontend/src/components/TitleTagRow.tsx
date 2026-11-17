import { useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { ContentNode, Tag } from "../lib/api";
import { addToast } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { tagWriter } from "../lib/data";
import { enabledTagFunctions, isViewModuleTag } from "../modules";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { isSystemTag } from "../lib/systemNodes";
import { isAppliedByAppTag, isTagShown, nodeTagIds } from "../lib/nodeTags";
import { tagName } from "../lib/hashtags";
import { isImeComposing, isEscapeKey } from "../lib/keys";
import { tagSuggestions } from "../lib/tagSuggestions";
import { classNames } from "../lib/utils";
import { TagName } from "./FunctionChip";
import { Popover, Pressable, keepFocus, useInlinePopover, TextField } from "./ui";

// The note's tags, in the grey line under its title (NoteMetaLine): the place
// people look for them, and the only place to add one. A chip toggles that tag's card (NoteTagsBlock
// draws it below the row). Applied tags are real memberships (the same ones the inspector edits);
// "＋" finds an existing tag as you type, or creates the typed name and
// applies it in one step. A `#word` written in the body is not a tag (T10,
// 2026-10-16) and is not listed here.

type Props = {
  node: ContentNode;
  tags: Tag[];
  /** The chip of `tagId` was clicked: the host expands or closes its card. */
  onToggleTag: (tagId: string) => void;
  /** The tag whose card is open, and the id of that card (aria-controls). */
  expandedTagId?: string | null;
  cardId?: string;
  /** The note cannot be edited by this person: tags show, nothing changes. */
  readOnly?: boolean;
};

/** A typed tag name: no leading '#', no surrounding space. */
export const cleanTagName = tagName;

export { tagSuggestions };

export default function TitleTagRow(props: Props) {
  return <TagRow key={props.node.id} {...props} />;
}

function TagRow({ node, tags, onToggleTag, expandedTagId, cardId, readOnly }: Props) {
  const t = useT();
  const isImported = useModuleFilter();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);

  const visible = useMemo(() => tags.filter((tag) => !isSystemTag(tag)), [tags]);
  const memberships = new Set(nodeTagIds(node));
  // A hidden tag (D104) stays on the note but shows no chip.
  const applied = visible.filter((tag) => memberships.has(tag.id) && isTagShown(tag));
  // A view module tag (#月曆…) describes tags, never a note (rule 6): not offered.
  // A hidden tag is offered only for its exact name (tagSuggestions).
  const available = visible.filter((tag) => !memberships.has(tag.id) && !isViewModuleTag(tag));

  const name = cleanTagName(query);
  const suggestions = tagSuggestions(available, query);
  // A picker hint, stricter than the server's name rule (exact title among
  // root siblings, services/tagHierarchy.ts): any tag whose name differs only
  // in case or parent is offered instead of creating a near-duplicate.
  const exact = visible.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
  // A "/" is a path (#a/b in a note makes two levels); this row creates one
  // tag, so it offers no "Create" for it (tagWriter.create refuses it too).
  const canCreate = !!name && !exact && !name.includes("/");
  // Rows: suggestions, then "Create #name" when nothing matches exactly.
  const rowCount = suggestions.length + (canCreate ? 1 : 0);
  // The list hangs under the input and leaves focus in it (the input owns ↑/↓/Enter/Esc).
  const options = useInlinePopover<HTMLInputElement>({ open: adding && rowCount > 0, onClose: close, placement: "bottom-start" });
  const confirming = applied.find((tag) => tag.id === confirmId) ?? null;
  const functions = (tag: Tag) => enabledTagFunctions(tag, isImported).map(({ title }) => t(title)).join(" · ");

  /** Runs one tag write at a time; true when it was accepted or queued. */
  async function run(job: () => Promise<{ status?: string; queued?: boolean } | void>): Promise<boolean> {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    try {
      const result = await job();
      if (result && (result.status === "queued" || result.queued)) addToast(t("Tag saved locally; waiting to sync."), "info");
      return true;
    } catch { return false; /* The writer already reported it. */ }
    finally { writing.current = false; setBusy(false); }
  }

  function close() { setAdding(false); setQuery(""); setActive(0); }

  function apply(tag: Tag) {
    close();
    void run(() => tagWriter.apply(node.id, tag.id));
  }

  function createAndApply() {
    if (!canCreate) return;
    const typed = name;
    close();
    void run(async () => {
      const created = await tagWriter.create(typed);
      const applied = await tagWriter.apply(node.id, created.id);
      return { queued: created.queued || applied.status === "queued" };
    });
  }

  function choose(index: number) {
    if (index < suggestions.length) apply(suggestions[index]!);
    else createAndApply();
  }

  function remove(tag: Tag) {
    // A tag with functions changes more than a label: say so once before removing it.
    if (confirmId !== tag.id && functions(tag)) { setConfirmId(tag.id); return; }
    // A refused removal keeps the confirmation open for a retry.
    void run(() => tagWriter.remove(node.id, tag.id)).then((ok) => { if (ok) setConfirmId(null); });
  }

  return (
    <div className={classNames("obsidian-prop-strip title-tag-row", applied.length === 0 && "title-tag-row--empty")} aria-label={t("Note tags")}>
      {applied.map((tag) => (
        <span key={tag.id} className="prop-tag prop-tag--applied">
          <Pressable type="button" className="prop-tag-name tap-target" onClick={() => onToggleTag(tag.id)} title={t("Show this tag's fields")}
            aria-expanded={expandedTagId === tag.id} aria-controls={expandedTagId === tag.id ? cardId : undefined}><TagName tag={tag} /></Pressable>
          {/* A tag only the app puts on a note (收件匣) is also only taken off by the app: filing the capture on the inbox page. */}
          {!readOnly && !isAppliedByAppTag(tag) && <Pressable type="button" className="prop-tag-remove" disabled={busy}
            aria-label={t("Remove #{name} from this note", { name: tag.name })}
            onClick={() => remove(tag)}><X size={11} /></Pressable>}
        </span>
      ))}
      {readOnly ? null : adding ? (
        <span className="title-tag-add">
          <TextField
            ref={options.anchor}
            autoFocus
            className="title-tag-input"
            value={query}
            placeholder={t("Tag name")}
            aria-label={t("Add a tag")}
            role="combobox"
            aria-expanded={rowCount > 0}
            aria-controls="title-tag-options"
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (isEscapeKey(event)) { event.preventDefault(); close(); }
              else if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(rowCount - 1, 0))); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (event.key === "Enter") {
                event.preventDefault();
                // Already on the note: nothing to add.
                if (exact && memberships.has(exact.id)) close();
                else if (rowCount > 0) choose(Math.min(active, rowCount - 1));
              }
            }}
            onBlur={() => { setTimeout(close, 150); }}
          />
          {rowCount > 0 && (
            <Popover popover={options} label={t("Suggestions")} role="group" className="title-tag-popover">
            <ul id="title-tag-options" className="title-tag-options" role="listbox">
              {suggestions.map((tag, i) => (
                <li key={tag.id} role="option" aria-selected={i === active}
                  className={i === active ? "active" : undefined}
                  onMouseDown={(event) => { keepFocus(event); apply(tag); }}><TagName tag={tag} /></li>
              ))}
              {canCreate && (
                <li role="option" aria-selected={active === suggestions.length}
                  className={active === suggestions.length ? "active title-tag-create" : "title-tag-create"}
                  onMouseDown={(event) => { keepFocus(event); createAndApply(); }}>
                  {t("Create #{name}", { name })}
                </li>
              )}
            </ul>
            </Popover>
          )}
        </span>
      ) : (
        // With tags the "＋" is just the sign; with none it says what it adds.
        // On a wide screen an empty row shows it only while the title area is
        // pointed at or focused, so a note without tags has no empty spot.
        <Pressable type="button" className="prop-tag prop-tag--add tap-target" disabled={busy} onClick={() => setAdding(true)}
          aria-label={applied.length > 0 ? t("Add a tag") : undefined}
          title={applied.length > 0 ? t("Add a tag") : undefined}>
          <Plus size={11} aria-hidden="true" />{applied.length === 0 && <> {t("Tag")}</>}
        </Pressable>
      )}
      {confirming && (
        <span className="title-tag-confirm" role="group" aria-label={t("Remove #{name} from this note", { name: confirming.name })}>
          {t("Remove #{name}? This note will stop receiving {functions}.", { name: confirming.name, functions: functions(confirming) })}
          <Pressable type="button" disabled={busy} onClick={() => remove(confirming)}>{t("Remove tag")}</Pressable>
          <Pressable type="button" onClick={() => setConfirmId(null)}>{t("Cancel")}</Pressable>
        </span>
      )}
    </div>
  );
}
