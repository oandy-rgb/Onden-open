// The home-page studio (desktop): Puck's composition API laid out as 區塊 |
// 畫布 | 屬性・建議. The left column is the kinds of block; the right one says
// which note or tag the selected block shows, and with nothing selected holds
// the site's settings. Every component only points at notes and tags; the
// canvas draws them with the site's own components (@onden/site/react), inside
// the same `.site-scope` frame, so it looks like the published page.
import "@puckeditor/core/no-external.css"; // not puck.css: that @imports a font from another host
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Puck, Render, createUsePuck, type Config, type PuckAction } from "@puckeditor/core";
import { embedLabel, parseEmbed } from "@onden/markdown";
import { expandPattern, validateDesignV2, withImplicitStacks, type PuckComponentData, type SchemeMode, type SiteDesignV2, type SiteStyle } from "@onden/site";
import { CloudUpload } from "lucide-react";
import { Link, Pressable, Tab, TabList, TabPanel } from "../../../components/ui";
import { makeMarkdownRenderer } from "../../../components/markdownSurfaces";
import { nodeNeedsBody, type ContentNode } from "../../../lib/api";
import { addToast, useTagRows, useAllNodes } from "../../../lib/appStore";
import { reads } from "../../../lib/data";
import { useCapabilities } from "../../../lib/capabilities";
import { lazyWithReload } from "../../../lib/lazyWithReload";
import { useT } from "../../../lib/i18n";
import { copyUrl } from "../copyUrl";
import SitePublishDialog from "../SitePublishDialog";
import { SAVE_STATUS_TEXT } from "./designAutosave";
import BlocksPanel, { type Prefill } from "./BlocksPanel";
import Bridge from "./Bridge";
import { findComponent } from "./designModel";
import { PUCK_DICTIONARY_ZH_TW } from "./dictionary";
import { buildEditorMeta, noteMarkdown, referencedNoteIds } from "./editorData";
import { prefillOnAction } from "./prefill";
import { loadSavedViews } from "./savedViews";
import InsertMenu from "./InsertMenu";
import { SiteScope, useDefaultSchemeMode } from "./SiteScope";
import SiteSettingsPanel, { type SiteInfo } from "./SiteSettingsPanel";
import { StudioDataContext, type SavedViewChoice, type StudioData } from "./studioContext";
import { createStudioConfig } from "./studioConfig";
import SuggestPanel from "./SuggestPanel";
import { computeSuggestions, type Suggestion } from "./suggestions";
import type { HomeStudioState } from "./useHomeStudio";
import "./HomeStudio.css";

const EmbedEditSheet = lazyWithReload(() => import("../../../components/EmbedEditSheet"));
const usePuck = createUsePuck();

const VIEWPORTS = [
  { width: "100%" as const, label: "桌面" },
  { width: 390, label: "手機" },
];
// Puck starts at its own 360px unless told otherwise.
const INITIAL_UI = { viewports: { current: { width: "100%" as const, height: "auto" as const }, controlsVisible: false, options: VIEWPORTS } };

type StudioTab = "props" | "suggest";
const TABS: ReadonlyArray<{ id: StudioTab; label: string }> = [
  { id: "props", label: "屬性" },
  { id: "suggest", label: "建議" },
];
const MODES: ReadonlyArray<{ mode: SchemeMode; label: string }> = [
  { mode: "light", label: "淺" },
  { mode: "dark", label: "深" },
];
const PHONE_PREVIEW_PX = 390;

type Preview = { suggestion: Suggestion; design: SiteDesignV2; alsoPublished?: ReadonlySet<string> };
type BlockEdit = { node: ContentNode; blockId: string };

function ViewportToggle() {
  const width = usePuck((s) => s.appState.ui.viewports.current.width);
  const dispatch = usePuck((s) => s.dispatch);
  return (
    <div className="hs-viewports" role="group" aria-label="預覽寬度">
      {VIEWPORTS.map((viewport) => (
        <Pressable
          key={viewport.label} type="button" className="hs-button" aria-pressed={width === viewport.width}
          onClick={() => dispatch({
            type: "setUi",
            ui: (prev) => ({ viewports: { ...prev.viewports, current: { width: viewport.width, height: "auto" } } }),
          })}
        >{viewport.label}</Pressable>
      ))}
    </div>
  );
}

/** 淺｜深: which colours the canvas draws. The preview only — it is not in the design. */
function ModeToggle({ mode, onMode }: { mode: SchemeMode; onMode: (mode: SchemeMode) => void }) {
  return (
    <div className="hs-viewports" role="group" aria-label="預覽配色">
      {MODES.map((choice) => (
        <Pressable key={choice.mode} type="button" className="hs-button" aria-pressed={mode === choice.mode} onClick={() => onMode(choice.mode)}>{choice.label}</Pressable>
      ))}
    </div>
  );
}

function Canvas({ shown, mode, onMode, preview, config, meta, onDoubleClick, onCancelPreview, onApplyPreview, applying }: {
  shown: SiteDesignV2;
  mode: SchemeMode;
  onMode: (mode: SchemeMode) => void;
  preview: Preview | null;
  config: Config;
  meta: ReturnType<typeof buildEditorMeta>;
  onDoubleClick: (componentId: string) => void;
  onCancelPreview: () => void;
  onApplyPreview: () => void;
  applying: boolean;
}) {
  const width = usePuck((s) => s.appState.ui.viewports.current.width);
  const frameRef = useRef<HTMLDivElement>(null);
  return (
    <div className="hs-canvas">
      <div className="hs-canvas__bar">
        <ViewportToggle />
        <ModeToggle mode={mode} onMode={onMode} />
        {preview && (
          <div className="hs-preview-banner" role="status">
            <span>預覽：{preview.suggestion.text}</span>
            <Pressable type="button" className="hs-button hs-button--primary" disabled={applying} onClick={onApplyPreview}>套用</Pressable>
            <Pressable type="button" className="hs-button" onClick={onCancelPreview}>取消</Pressable>
          </div>
        )}
      </div>
      <div className="hs-canvas__scroll">
        <div
          ref={frameRef} className="hs-canvas__frame" style={{ "--hs-width": width === "100%" ? "100%" : `${width}px` } as CSSProperties} data-width={width === "100%" ? "desktop" : "phone"}
          onDoubleClick={(e) => {
            const id = (e.target as HTMLElement).closest("[data-node]")?.getAttribute("data-node");
            if (id) onDoubleClick(id);
          }}
        >
          <SiteScope design={shown} mode={mode} viewport={width === "100%" ? undefined : PHONE_PREVIEW_PX}>
            <div hidden={preview !== null}><Puck.Preview /></div>
            {preview && <Render config={config} data={withImplicitStacks(shown.home)} metadata={meta} />}
          </SiteScope>
          {preview === null && <InsertMenu config={config} frameRef={frameRef} />}
        </div>
      </div>
    </div>
  );
}

function RightPanel({ tab, setTab, design, suggestions, previewId, busy, onStyle, onCss, info, onInfo, onPreview, onApply }: {
  tab: StudioTab;
  setTab: (tab: StudioTab) => void;
  design: SiteDesignV2;
  suggestions: readonly Suggestion[];
  previewId: string | null;
  busy: boolean;
  onStyle: (style: SiteStyle) => void;
  onCss: (css: string) => void;
  info: SiteInfo;
  onInfo: (patch: Partial<SiteInfo>) => void;
  onPreview: (suggestion: Suggestion) => void;
  onApply: (suggestion: Suggestion) => void;
}) {
  const selected = usePuck((s) => s.selectedItem);
  const getSelectorForId = usePuck((s) => s.getSelectorForId);
  const dispatch = usePuck((s) => s.dispatch);
  const isPattern = selected !== null && selected.type.startsWith("pattern_");

  const select = (componentId: string) => {
    const selector = getSelectorForId(componentId);
    if (selector) dispatch({ type: "setUi", ui: { itemSelector: selector } });
    setTab("props");
  };
  // Nothing selected is where the site's settings are.
  const showSettings = () => {
    dispatch({ type: "setUi", ui: { itemSelector: null } });
    setTab("props");
  };
  const expand = () => {
    if (!selected) return;
    const selector = getSelectorForId(selected.props.id as string);
    if (!selector) return;
    dispatch({ type: "replace", destinationIndex: selector.index, destinationZone: selector.zone, data: expandPattern(selected as PuckComponentData) });
  };

  return (
    <div className="hs-right">
      <TabList className="hs-tabs" label="面板">
        {TABS.map(({ id, label }) => (
          <Tab
            key={id} id={`hs-tab-${id}`} selected={tab === id} controls={`hs-panel-${id}`}
            className="hs-tab" onClick={() => setTab(id)}
          >{label}{id === "suggest" && suggestions.length > 0 ? `（${suggestions.length}）` : ""}</Tab>
        ))}
      </TabList>
      <TabPanel className="hs-panel" id={`hs-panel-${tab}`} labelledBy={`hs-tab-${tab}`}>
        {tab === "props" && (selected ? (
          <>
            {isPattern && (
              <div className="hs-pattern-note">
                <p>這是區塊範本，通常只要換內容。</p>
                <Pressable type="button" className="hs-button" onClick={expand}>展開成零件</Pressable>
              </div>
            )}
            <Puck.Fields />
          </>
        ) : (
          <>
            <p className="hs-hint">點一下畫布上的區塊，就能在這裡調整它。沒選東西時，這裡是整個網站的設定。</p>
            <SiteSettingsPanel design={design} onStyle={onStyle} onCss={onCss} info={info} onInfo={onInfo} />
          </>
        ))}
        {tab === "suggest" && (
          <SuggestPanel
            suggestions={suggestions} previewId={previewId} busy={busy} onPreview={onPreview}
            onApply={(suggestion) => {
              if (suggestion.selectComponentId && !suggestion.design && !suggestion.includeNoteIds) select(suggestion.selectComponentId);
              else if (suggestion.styleTab && !suggestion.design) showSettings();
              else onApply(suggestion);
            }}
          />
        )}
      </TabPanel>
    </div>
  );
}

export default function HomeStudio({ site, onOpenNode, onBack }: { site: HomeStudioState; onOpenNode: (id: string) => void; onBack?: () => void }) {
  const t = useT();
  const { design, notes, tags, online } = site;
  const nodes = useAllNodes();
  const allTags = useTagRows();
  const capabilities = useCapabilities(online);
  const config = useMemo(() => createStudioConfig(), []);

  // What the page points at gets its text read when this device holds only the title.
  const referenced = useMemo(() => referencedNoteIds(design), [design]);
  const { wantBodies } = site;
  useEffect(() => { wantBodies(referenced); }, [referenced, wantBodies]);

  // ── Suggestion previews ──
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applying, setApplying] = useState(false);
  const shown = preview?.design ?? design;

  // ── 淺｜深: the canvas follows the site's 配色 setting (a site that follows
  // the visitor follows Onden's own light or dark); the switch is the preview's
  // alone and gives way when the setting changes.
  const defaultMode = useDefaultSchemeMode(design.style.scheme);
  const [modeChoice, setModeChoiceState] = useState<{ scheme: SiteDesignV2["style"]["scheme"]; mode: SchemeMode } | null>(null);
  if (modeChoice && modeChoice.scheme !== design.style.scheme) setModeChoiceState(null);
  const mode = modeChoice?.mode ?? defaultMode;
  const setModeChoice = (next: SchemeMode) => setModeChoiceState({ scheme: design.style.scheme, mode: next });

  const renderMarkdown = useMemo(() => makeMarkdownRenderer(nodes, () => {}), [nodes]);
  const meta = useMemo(
    () => buildEditorMeta({ nodes, tags: allTags ?? [], notes, design: shown, bodies: site.bodies, alsoPublished: preview?.alsoPublished, renderMarkdown }),
    [nodes, allTags, notes, shown, site.bodies, preview?.alsoPublished, renderMarkdown],
  );
  // Suggestions look at the saved design, with the rows the canvas shows for it.
  const designMeta = useMemo(
    () => (shown === design ? meta : buildEditorMeta({ nodes, tags: allTags ?? [], notes, design, bodies: site.bodies, renderMarkdown })),
    [shown, design, meta, nodes, allTags, notes, site.bodies, renderMarkdown],
  );
  const suggestions = useMemo(() => {
    const rowCounts = Object.fromEntries(Object.entries(designMeta.resolved).map(([id, rows]) => [id, rows.length]));
    return computeSuggestions({ design, notes, blocked: site.blocked, rowCounts });
  }, [design, notes, site.blocked, designMeta]);

  const startPreview = (suggestion: Suggestion) => {
    setPreview({
      suggestion,
      design: suggestion.design ?? design,
      alsoPublished: suggestion.includeNoteIds ? new Set(suggestion.includeNoteIds) : undefined,
    });
  };
  const applySuggestion = async (suggestion: Suggestion) => {
    setApplying(true);
    try {
      if (suggestion.includeNoteIds && !(await site.publish.include(suggestion.includeNoteIds))) return;
      if (suggestion.design) site.applyDesign(validateDesignV2(suggestion.design).design);
      setPreview(null);
    } finally { setApplying(false); }
  };

  // ── Drag from the drawer: the chosen note / tag rides in on the insert ──
  const prefillRef = useRef<Prefill>(null);
  const dispatchRef = useRef<((action: PuckAction) => void) | null>(null);
  const onAction = useMemo(() => prefillOnAction(prefillRef, dispatchRef), []);

  // ── Double-click a paragraph: edit its source in place ──
  const [blockEdit, setBlockEdit] = useState<BlockEdit | null>(null);
  const editFromCanvas = (componentId: string) => {
    const component = findComponent(design.home, componentId);
    if (!component || component.type !== "note") return;
    const noteId = String(component.props.noteId ?? "");
    const node = nodes.find((n) => n.id === noteId);
    if (!node) return;
    const blockId = String(component.props.blockId ?? "");
    // A whole note or its first paragraph has no paragraph id to edit by; the note is the place.
    if (blockId) setBlockEdit({ node, blockId });
    else onOpenNode(node.id);
  };
  const embed = useMemo(() => {
    if (!blockEdit) return null;
    const ref = parseEmbed(`${blockEdit.node.title}#^${blockEdit.blockId}`);
    return { kind: "block" as const, ref, label: embedLabel(ref), node: blockEdit.node, blockId: blockEdit.blockId };
  }, [blockEdit]);

  // ── Picker data ──
  const viewCache = useRef(new Map<string, SavedViewChoice[]>());
  const studioData = useMemo<StudioData>(() => ({
    notes, tags,
    markdownOf: (id) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return null;
      return nodeNeedsBody(node) ? site.bodies.get(id) ?? null : noteMarkdown(node);
    },
    savedViews: async (tagId) => {
      const cached = viewCache.current.get(tagId);
      if (cached) return cached;
      if (!online) return [];
      const list = await loadSavedViews(tagId);
      viewCache.current.set(tagId, list);
      return list;
    },
    openNote: onOpenNode,
    publishNote: site.publishNote,
    unpublishNote: site.unpublishNote,
  }), [notes, tags, nodes, site.bodies, online, onOpenNode, site.publishNote, site.unpublishNote]);

  // ── The editor ──
  const initialHome = useMemo(() => design.home, [site.designVersion]); // eslint-disable-line react-hooks/exhaustive-deps -- Puck reads `data` once; a new version remounts it
  const onRefuse = useCallback(() => addToast("這裡不能放零件", "info"), []);
  const [tab, setTab] = useState<StudioTab>("props");
  const settings = site.settings.value;

  const saveKey = SAVE_STATUS_TEXT[site.save.status];

  return (
    <section className="hs-studio" aria-label="首頁工作室">
      <SitePublishDialog site={site} />
      {embed && (
        <Suspense fallback={null}>
          <EmbedEditSheet
            embed={embed} hostNodeId={null}
            canEdit={capabilities.canEdit({ node_type: "content", space_id: embed.node.space_id ?? null })}
            onOpenSource={(id) => { setBlockEdit(null); onOpenNode(id); }}
            onRevealSyntax={() => {}} onClose={() => setBlockEdit(null)}
          />
        </Suspense>
      )}

      <header className="hs-toolbar">
        <h1 className="hs-toolbar__title">首頁</h1>
        {onBack && <Pressable type="button" className="hs-button" onClick={onBack}>{t("Back to the site designer")}</Pressable>}
        <div className="hs-toolbar__actions">
          {saveKey && (
            <span className="hs-save" data-status={site.save.status} role="status" aria-live="polite">
              {t(saveKey)}
              {site.save.status === "error" && <Pressable type="button" className="hs-link" onClick={() => { void site.save.retry(); }}>{t("Retry saving")}</Pressable>}
            </span>
          )}
          <Pressable
            type="button" className="hs-button hs-button--primary pub-publish-button"
            disabled={!online || site.publish.status === "publishing" || site.publish.loading}
            onClick={() => void site.publish.start()}
          >{site.publish.status === "publishing" ? "發布中…" : site.publish.loading ? "…" : "發布"}</Pressable>
          {site.publish.url && (
            <>
              <Link className="hs-button" href={site.publish.url} target="_blank" rel="noreferrer">開啟網站</Link>
              <Pressable type="button" className="hs-button" onClick={() => copyUrl(site.publish.url!)}>複製網址</Pressable>
              <Link className="hs-button" href={reads.modules.links.staticExport()} download><CloudUpload size={13} aria-hidden="true" /> 匯出</Link>
            </>
          )}
        </div>
      </header>

      <StudioDataContext.Provider value={studioData}>
        <Puck
          key={site.designVersion}
          config={config}
          data={initialHome}
          iframe={{ enabled: false }}
          viewports={VIEWPORTS}
          ui={INITIAL_UI}
          dictionary={PUCK_DICTIONARY_ZH_TW}
          metadata={meta}
          onAction={onAction as never}
        >
          <Bridge initial={initialHome} onHome={site.setHome} onRefuse={onRefuse} dispatchRef={dispatchRef} />
          <div className="hs-body">
            <aside className="hs-left" aria-label="區塊">
              <BlocksPanel config={config} prefillRef={prefillRef} online={online} />
            </aside>
            <main className="hs-center">
              <Canvas
                shown={shown} mode={mode} onMode={setModeChoice} preview={preview} config={config} meta={meta} applying={applying}
                onDoubleClick={editFromCanvas}
                onCancelPreview={() => setPreview(null)}
                onApplyPreview={() => { if (preview) void applySuggestion(preview.suggestion); }}
              />
            </main>
            <aside className="hs-right-wrap" aria-label="屬性與建議">
              <RightPanel
                tab={tab} setTab={setTab} design={design} suggestions={suggestions} previewId={preview?.suggestion.id ?? null} busy={applying}
                onStyle={(style) => site.changeDesign((d) => ({ ...d, style }))}
                onCss={(css) => site.changeDesign((d) => ({ ...d, css }))}
                info={{ brand: settings.brand ?? "", tagline: settings.tagline ?? "", logo: settings.logo ?? "", favicon: settings.favicon ?? "" }}
                onInfo={(patch) => site.settings.set((s) => ({ ...s, ...patch }))}
                onPreview={startPreview} onApply={(suggestion) => void applySuggestion(suggestion)}
              />
            </aside>
          </div>
        </Puck>
      </StudioDataContext.Provider>
    </section>
  );
}
