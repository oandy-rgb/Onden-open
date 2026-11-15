// The home studio on a phone. It never loads Puck: the layout is an ordered
// list of the page's top-level blocks, edited through the few moves in
// phoneHome.ts, and the page is drawn below with the site's own components
// (@onden/site/react through Puck's server `Render`). It edits the same
// SiteDesignV2 as the desktop studio and saves through the same useHomeStudio
// (autosave, `rev` conflict handling, validateDesignV2), and publishes through
// the same review dialog first. Creating parts, nesting, dragging, CSS and
// per-part settings are not here at all.
import { useEffect, useId, useMemo, useState } from "react";
import { Render } from "@puckeditor/core/rsc";
import { PATTERN_TYPES, validateDesignV2, withImplicitStacks, type PatternType, type SiteDesignV2 } from "@onden/site";
import { COMPONENT_LABELS, createPuckConfig } from "@onden/site/react";
import { makeMarkdownRenderer } from "../../../components/markdownSurfaces";
import ShellDialog from "../../../components/ShellDialog";
import { useTagRows, useAllNodes } from "../../../lib/appStore";
import { useT } from "../../../lib/i18n";
import { copyUrl } from "../copyUrl";
import SitePublishDialog from "../SitePublishDialog";
import { SAVE_STATUS_TEXT } from "../studio/designAutosave";
import { buildEditorMeta, referencedNoteIds } from "../studio/editorData";
import { loadSavedViews } from "../studio/savedViews";
import SiteImageField from "../studio/SiteImageField";
import { SiteScope } from "../studio/SiteScope";
import StyleChoices from "../studio/StyleChoices";
import type { SavedViewChoice } from "../studio/studioContext";
import type { HomeStudioState } from "../studio/useHomeStudio";
import {
  blockRows, deleteBlock, insertPattern, moveBlock, patternSlots, swapNote, swapTagView,
  type SlotChoice, type TagViewChoice,
} from "./phoneHome";
import "./PhoneHomeStudio.css";
import { displayTitle } from "../../../lib/noteLabel";
import { containsTitle } from "../../../lib/noteSearch";
import EmptyState from "../../../components/EmptyState";
import { Link, Pressable, Select, SearchField } from "../../../components/ui";

const LIST_MAX = 30;

// ── Pickers ──────────────────────────────────────────────────────────────

function Search({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <>
      <SearchField id={id} label="搜尋…" value={value} onValueChange={onChange} />
    </>
  );
}

/** Published notes only: the page never points at a note the site would leave out. */
function NotePicker({ site, onPick }: { site: HomeStudioState; onPick: (noteId: string) => void }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return site.notes.filter((n) => n.published && (needle === "" || containsTitle(needle, n.title))).slice(0, LIST_MAX);
  }, [site.notes, query]);
  // Marked notes the site leaves out, named by space: an empty list then says why.
  const blockedSpaces = useMemo(() => {
    const blocked = site.blocked.filter((n) => n.marked);
    const spaces = new Set<string>();
    for (const n of blocked) if (n.blocker.reason === "space") spaces.add(n.blocker.space);
    return { count: blocked.length, spaces: [...spaces] };
  }, [site.blocked]);
  const noneAtAll = !site.notes.some((n) => n.published);
  return (
    <div>
      <Search value={query} onChange={setQuery} />
      <ul className="ph-pick-list">
        {shown.map((n) => (
          <li key={n.id}><Pressable type="button" className="ph-pick" onClick={() => onPick(n.id)}>{displayTitle(n.title)}</Pressable></li>
        ))}
        {shown.length === 0 && <EmptyState size="inline" as="li" title="沒有符合的已發布筆記。" />}
        {shown.length === 0 && noneAtAll && blockedSpaces.count > 0 && (
          <li className="ph-empty" data-testid="phone-blocked-reason">
            {`有 ${blockedSpaces.count} 篇標了發布，但${blockedSpaces.spaces.length > 0 ? `放在不允許發布的空間（${blockedSpaces.spaces.join("、")}）` : "被隱藏"}。`}
          </li>
        )}
      </ul>
    </div>
  );
}

/** A tag, then (when it has saved views) one of its views. */
function TagViewPicker({ site, onPick }: { site: HomeStudioState; onPick: (choice: TagViewChoice) => void }) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<{ id: string; name: string } | null>(null);
  const [views, setViews] = useState<SavedViewChoice[] | null>(null);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return site.tags.filter((t) => needle === "" || containsTitle(needle, t.name)).slice(0, LIST_MAX);
  }, [site.tags, query]);

  const chooseTag = (id: string, name: string) => {
    setTag({ id, name }); setViews(null);
    const load = site.online ? loadSavedViews(id) : Promise.resolve([] as SavedViewChoice[]);
    void load.then((list) => {
      // A tag without saved views has nothing more to ask: its default view.
      if (list.length === 0) onPick({ tagId: id, viewId: "", viewKind: "list" });
      else setViews(list);
    }, () => onPick({ tagId: id, viewId: "", viewKind: "list" }));
  };

  if (tag && views) {
    return (
      <div>
        <p className="ph-hint">「{tag.name}」要用哪個檢視？</p>
        <ul className="ph-pick-list">
          <li><Pressable type="button" className="ph-pick" onClick={() => onPick({ tagId: tag.id, viewId: "", viewKind: "list" })}>標籤預設</Pressable></li>
          {views.map((view) => (
            <li key={view.id}><Pressable type="button" className="ph-pick" onClick={() => onPick({ tagId: tag.id, viewId: view.id, viewKind: view.kind })}>{view.name}</Pressable></li>
          ))}
        </ul>
        <Pressable type="button" className="ph-btn" onClick={() => { setTag(null); setViews(null); }}>重選標籤</Pressable>
      </div>
    );
  }
  return (
    <div>
      <Search value={query} onChange={setQuery} />
      <ul className="ph-pick-list" aria-busy={tag !== null}>
        {shown.map((t) => (
          <li key={t.id}>
            <Pressable type="button" className="ph-pick" disabled={tag !== null} onClick={() => chooseTag(t.id, t.name)}>
              <span>{t.name}</span><span className="ph-pick__note">{t.memberCount} 篇</span>
            </Pressable>
          </li>
        ))}
        {shown.length === 0 && <EmptyState size="inline" as="li" title="沒有符合的標籤。" />}
      </ul>
    </div>
  );
}

// ── Sheets ───────────────────────────────────────────────────────────────

// A bottom sheet, like the app's other phone sheets (ShellDialog + .ph-sheet).
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <ShellDialog sheet="bottom" label={label} className="ph-sheet" onClose={onClose}>
      <div className="ph-sheet__head">
        <h2 className="ph-sheet__title">{label}</h2>
        <Pressable type="button" className="ph-btn" onClick={onClose}>關閉</Pressable>
      </div>
      {children}
    </ShellDialog>
  );
}

function InsertSheet({ site, rows, onInsert, onClose }: {
  site: HomeStudioState;
  rows: ReadonlyArray<{ id: string; title: string }>;
  onInsert: (type: PatternType, position: number, choices: SlotChoice[]) => void;
  onClose: () => void;
}) {
  const positionId = useId();
  const [type, setType] = useState<PatternType | null>(null);
  const [position, setPosition] = useState(rows.length);
  const [choices, setChoices] = useState<Array<SlotChoice | null>>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const slots = type ? patternSlots(type) : [];

  if (type && picking !== null) {
    const slot = slots[picking]!;
    const choose = (choice: SlotChoice) => { setChoices((prev) => prev.map((c, i) => (i === picking ? choice : c))); setPicking(null); };
    return (
      <Sheet label={slot.kind === "note" ? "選一篇筆記" : "選一個標籤"} onClose={() => setPicking(null)}>
        {slot.kind === "note"
          ? <NotePicker site={site} onPick={(noteId) => choose({ kind: "note", noteId })} />
          : <TagViewPicker site={site} onPick={(choice) => choose({ kind: "tag_view", ...choice })} />}
      </Sheet>
    );
  }
  if (!type) {
    return (
      <Sheet label="插入區塊範本" onClose={onClose}>
        <ul className="ph-pick-list">
          {PATTERN_TYPES.map((pattern) => (
            <li key={pattern}>
              <Pressable type="button" className="ph-pick" onClick={() => { setType(pattern); setChoices(patternSlots(pattern).map(() => null)); }}>
                {COMPONENT_LABELS[pattern]}
              </Pressable>
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }
  const noteTitle = (id: string) => displayTitle(site.notes.find((n) => n.id === id)?.title);
  const tagName = (id: string) => displayTitle(site.tags.find((t) => t.id === id)?.name);
  const complete = choices.every((c) => c !== null);
  return (
    <Sheet label={COMPONENT_LABELS[type]} onClose={onClose}>
      <ul className="ph-pick-list">
        {slots.map((slot, i) => {
          const choice = choices[i];
          return (
            <li key={`${slot.slot}-${slot.index}`}>
              <Pressable type="button" className="ph-pick" onClick={() => setPicking(i)}>
                <span>{slot.kind === "note" ? "筆記" : "標籤檢視"}</span>
                <span className="ph-pick__note">{choice ? (choice.kind === "note" ? noteTitle(choice.noteId) : tagName(choice.tagId)) : "還沒選"}</span>
              </Pressable>
            </li>
          );
        })}
      </ul>
      <label className="ph-label" htmlFor={positionId}>放在哪裡</label>
      <Select id={positionId} className="ph-input" value={position} onChange={(e) => setPosition(Number(e.target.value))}>
        <option value={0}>最前面</option>
        {rows.map((row, i) => <option key={row.id} value={i + 1}>{i + 1 === rows.length ? `最後（「${row.title}」之後）` : `「${row.title}」之後`}</option>)}
      </Select>
      <div className="ph-actions">
        <Pressable type="button" className="ph-btn" onClick={() => setType(null)}>換範本</Pressable>
        <Pressable
          type="button" className="ph-btn ph-btn--primary" disabled={!complete}
          onClick={() => onInsert(type, position, choices as SlotChoice[])}
        >插入</Pressable>
      </div>
    </Sheet>
  );
}

// ── Style ────────────────────────────────────────────────────────────────

function StyleSection({ design, onDesign }: { design: SiteDesignV2; onDesign: (change: (d: SiteDesignV2) => SiteDesignV2) => void }) {
  const headId = useId();
  return (
    <section className="ph-section" aria-labelledby={headId}>
      <h2 className="ph-h" id={headId}>風格</h2>
      <StyleChoices value={design.style} onChange={(style) => onDesign((d) => ({ ...d, style }))} />
    </section>
  );
}

// ── Logo and icon ────────────────────────────────────────────────────────

function SiteImagesSection({ logo, favicon, onChange }: {
  logo: string; favicon: string; onChange: (patch: { logo?: string; favicon?: string }) => void;
}) {
  const t = useT();
  const headingId = useId();
  return (
    <section className="ph-section" aria-labelledby={headingId}>
      <h2 className="ph-h" id={headingId}>{t("Logo and icon")}</h2>
      <SiteImageField label={t("Logo")} value={logo} onChange={(next) => onChange({ logo: next })} />
      <SiteImageField label={t("Site icon")} hint={t("The small icon on the browser tab")} value={favicon} onChange={(next) => onChange({ favicon: next })} />
    </section>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────

type Sheeting = { kind: "note" | "tag_view"; contentId: string } | { kind: "insert" } | null;

export default function PhoneHomeStudio({ site, onBack }: { site: HomeStudioState; onBack?: () => void }) {
  const t = useT();
  const { design, online } = site;
  const nodes = useAllNodes();
  const allTags = useTagRows();
  const config = useMemo(() => createPuckConfig(), []);
  const [sheet, setSheet] = useState<Sheeting>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const { wantBodies } = site;
  const referenced = useMemo(() => referencedNoteIds(design), [design]);
  useEffect(() => { wantBodies(referenced); }, [referenced, wantBodies]);

  const rows = useMemo(() => blockRows(design.home, {
    noteTitle: (id) => site.notes.find((n) => n.id === id)?.title ?? site.blocked.find((n) => n.id === id)?.title ?? null,
    notePublished: (id) => site.notes.find((n) => n.id === id)?.published ?? false,
    tagName: (id) => allTags?.find((tag) => tag.id === id)?.name ?? null,
  }), [design.home, site.notes, site.blocked, allTags]);

  const renderMarkdown = useMemo(() => makeMarkdownRenderer(nodes, () => {}), [nodes]);
  const meta = useMemo(
    () => buildEditorMeta({ nodes, tags: allTags ?? [], notes: site.notes, design, bodies: site.bodies, renderMarkdown }),
    [nodes, allTags, site.notes, design, site.bodies, renderMarkdown],
  );

  // Every move goes through validateDesignV2 before it is kept and saved.
  const change = (move: (d: SiteDesignV2) => SiteDesignV2) => site.changeDesign((d) => validateDesignV2(move(d)).design);
  const changeHome = (move: (home: SiteDesignV2["home"]) => SiteDesignV2["home"]) => change((d) => ({ ...d, home: move(d.home) }));

  const saveKey = SAVE_STATUS_TEXT[site.save.status];

  return (
    <section className="ph-studio" aria-label="首頁工作室">
      <SitePublishDialog site={site} />
      {sheet && (sheet.kind === "note" || sheet.kind === "tag_view") && (
        <Sheet label={sheet.kind === "note" ? "換一篇筆記" : "換標籤檢視"} onClose={() => setSheet(null)}>
          {sheet.kind === "note"
            ? <NotePicker site={site} onPick={(noteId) => { changeHome((h) => swapNote(h, sheet.contentId, noteId)); setSheet(null); }} />
            : <TagViewPicker site={site} onPick={(choice) => { changeHome((h) => swapTagView(h, sheet.contentId, choice)); setSheet(null); }} />}
        </Sheet>
      )}
      {sheet?.kind === "insert" && (
        <InsertSheet
          site={site} rows={rows} onClose={() => setSheet(null)}
          onInsert={(type, position, choices) => { changeHome((h) => insertPattern(h, type, position, choices)); setSheet(null); }}
        />
      )}

      <header className="ph-top">
        {onBack && <Pressable type="button" className="ph-btn" onClick={onBack}>{t("Back to the site designer")}</Pressable>}
        <Pressable
          type="button" className="ph-btn ph-btn--primary pub-publish-button"
          disabled={!online || site.publish.status === "publishing" || site.publish.loading}
          onClick={() => void site.publish.start()}
        >{site.publish.status === "publishing" ? "發布中…" : site.publish.loading ? "…" : "發布"}</Pressable>
      </header>
      {(saveKey || site.publish.url) && (
        <div className="ph-status">
          {saveKey && (
            <span className="ph-save" data-status={site.save.status} role="status" aria-live="polite">
              {t(saveKey!)}
              {site.save.status === "error" && <Pressable type="button" className="ph-link" onClick={() => { void site.save.retry(); }}>{t("Retry saving")}</Pressable>}
            </span>
          )}
          {site.publish.url && (
            <span className="ph-published">
              <Link className="ph-link" href={site.publish.url} target="_blank" rel="noreferrer">開啟網站</Link>
              <Pressable type="button" className="ph-link" onClick={() => copyUrl(site.publish.url!)}>複製網址</Pressable>
            </span>
          )}
        </div>
      )}

      <section className="ph-section" aria-labelledby="ph-layout-h">
        <h2 className="ph-h" id="ph-layout-h">版面</h2>
        {rows.length === 0 && <EmptyState size="inline" title="首頁還沒有內容，插入一個區塊範本開始。" />}
        <ol className="ph-blocks">
          {rows.map((row, i) => (
            <li key={row.id} className="ph-block" data-block={row.id}>
              <div className="ph-block__text">
                <span className="ph-block__title">{row.title}</span>
                {row.detail && <span className="ph-block__detail">{row.detail}</span>}
              </div>
              <div className="ph-block__actions">
                <Pressable type="button" className="ph-btn" disabled={i === 0} aria-label={`上移：${row.title}`} onClick={() => changeHome((h) => moveBlock(h, row.id, -1))}>上移</Pressable>
                <Pressable type="button" className="ph-btn" disabled={i === rows.length - 1} aria-label={`下移：${row.title}`} onClick={() => changeHome((h) => moveBlock(h, row.id, 1))}>下移</Pressable>
                {row.swap && (
                  <Pressable
                    type="button" className="ph-btn" aria-label={`${row.swap.kind === "note" ? "換筆記" : "換標籤檢視"}：${row.title}`}
                    onClick={() => setSheet({ kind: row.swap!.kind, contentId: row.swap!.id })}
                  >{row.swap.kind === "note" ? "換筆記" : "換標籤檢視"}</Pressable>
                )}
                {confirming === row.id ? (
                  <>
                    <Pressable type="button" className="ph-btn ph-btn--danger" aria-label={`確定刪除：${row.title}`} onClick={() => { changeHome((h) => deleteBlock(h, row.id)); setConfirming(null); }}>確定刪除</Pressable>
                    <Pressable type="button" className="ph-btn" onClick={() => setConfirming(null)}>取消</Pressable>
                  </>
                ) : (
                  <Pressable type="button" className="ph-btn" aria-label={`刪除：${row.title}`} onClick={() => setConfirming(row.id)}>刪除</Pressable>
                )}
              </div>
            </li>
          ))}
        </ol>
        <Pressable type="button" className="ph-btn ph-btn--wide" onClick={() => setSheet({ kind: "insert" })}>插入區塊範本</Pressable>
      </section>

      <SiteImagesSection
        logo={site.settings.value.logo ?? ""} favicon={site.settings.value.favicon ?? ""}
        onChange={(patch) => site.settings.set((s) => ({ ...s, ...patch }))}
      />
      <StyleSection design={design} onDesign={change} />

      <section className="ph-section" aria-labelledby="ph-preview-h">
        <h2 className="ph-h" id="ph-preview-h">預覽</h2>
        <div className="ph-preview" data-testid="phone-preview" data-empty={design.home.content.length === 0 || undefined}>
          {design.home.content.length === 0
            ? <EmptyState size="inline" title="加入區塊後，這裡會顯示首頁的樣子。" />
            : (
              <SiteScope design={design}>
                <Render config={config} data={withImplicitStacks(design.home)} metadata={meta} />
              </SiteScope>
            )}
        </div>
      </section>
    </section>
  );
}
