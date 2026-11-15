// The website screen (`?view=website`): the site itself, drawn from the owner's own notes by the
// same components the published pages use, with a bar of choices above it. A click on any slot opens
// 「換成…」 for that slot (SetupCanvas, ReplacePicker). The publish flow and its dialog are the
// ones the old home studio had.
import { Suspense, useCallback, useMemo, useState } from "react";
import { applyHomePreset, usesLegacyHome, type HomePresetId, type SiteDesign, type SiteStyle } from "@onden/site";
import { articleFacts, siteFacts, tagFacts } from "../../../components/siteFrame";
import { useT } from "../../../lib/i18n";
import SitePublishDialog from "../SitePublishDialog";
import { SAVE_STATUS_TEXT } from "../studio/designAutosave";
import type { SitePage } from "../SiteRender";
import AdvancedSection from "./AdvancedSection";
import SetupBar, { WIDTHS, type PageKind, type WidthId } from "./SetupBar";
import SetupCanvas from "./SetupCanvas";
import { withDesign } from "./previewSite";
import type { SiteSetupState } from "./useSiteSetup";
import { nodeOf } from "../../../lib/nodeIndex";
import "./SiteSetup.css";

type Props = { site: SiteSetupState; onOpenLegacy: () => void };

export default function SiteSetupScreen({ site, onOpenLegacy }: Props) {
  const t = useT();
  const { design, base, online } = site;
  const [pageKind, setPageKind] = useState<PageKind>("home");
  const [width, setWidth] = useState<WidthId>("desktop");
  const [readerOnly, setReaderOnly] = useState(false);
  const [noteChoice, setNoteChoice] = useState<string | null>(null);
  const [tagChoice, setTagChoice] = useState<string | null>(null);

  const noteId = base && noteChoice && base.nodes.some((n) => n.id === noteChoice) ? noteChoice : site.sampleNote;
  const tagId = base && tagChoice && tagChoice in base.design.tag_pages ? tagChoice : site.sampleTag;
  const page = useMemo<SitePage | null>(() => pageKind === "home" ? { kind: "home" }
    : pageKind === "note" ? (noteId ? { kind: "note", noteId } : null)
    : tagId ? { kind: "tag", tagId } : null, [pageKind, noteId, tagId]);

  // What the pickers ask: does the site have what each widget needs, on the page being shown.
  const data = useMemo(() => (base ? withDesign(base, design) : null), [base, design]);
  const facts = useMemo(() => {
    if (!data) return null;
    const note = page?.kind === "note" ? nodeOf(data, page.noteId) : undefined;
    if (note) return articleFacts(data, note);
    return page?.kind === "tag" ? tagFacts(data, page.tagId) : siteFacts(data);
  }, [data, page]);

  const setStyle = useCallback((style: SiteStyle) => site.change((d) => ({ ...d, style })), [site]);
  const setPreset = useCallback((id: HomePresetId) => site.change((d) => ({ ...d, preset: id, boxes: applyHomePreset(d.boxes, id) })), [site]);
  const setCss = useCallback((css: string) => site.change((d) => ({ ...d, css })), [site]);
  const setBoxes = useCallback((boxes: SiteDesign["boxes"]) => site.change((d) => ({ ...d, boxes })), [site]);

  const sample = !base ? undefined : pageKind === "note"
    ? { label: t("Note to preview"), value: noteId ?? "", options: base.nodes.filter((n) => n.id !== base.homeNodeId && !(n.id in base.design.tag_pages)).map((n) => ({ id: n.id, title: n.title })), onChange: setNoteChoice }
    : pageKind === "tag"
      ? { label: t("Tag to preview"), value: tagId ?? "", options: Object.entries(base.design.tag_pages).map(([id, p]) => ({ id, title: p.name })), onChange: setTagChoice }
      : undefined;

  const saveKey = SAVE_STATUS_TEXT[site.save.status];
  const px = WIDTHS.find((w) => w.id === width)?.px ?? null;

  return (
    <section className="ss" aria-label={t("Website")}>
      <SitePublishDialog site={site} />
      <SetupBar
        page={pageKind} onPage={setPageKind} width={width} onWidth={setWidth}
        preset={design.preset} onPreset={setPreset} legacyDrawn={usesLegacyHome(design)}
        look={design.style} onLook={setStyle}
        readerOnly={readerOnly} onReaderOnly={setReaderOnly}
        saveText={saveKey ? t(saveKey) : undefined} saveStatus={site.save.status} onRetry={() => { void site.save.retry(); }}
        online={online} publishing={site.publish.status === "publishing"} publishLoading={site.publish.loading}
        publishUrl={site.publish.url} onPublish={() => void site.publish.start()}
        sample={sample}
      />
      <AdvancedSection css={design.css} onCss={setCss} onOpenLegacy={onOpenLegacy} />
      {!base ? (
        <p className="ss-nothing" role="status">
          {!online ? t("The website preview needs a connection.") : site.previewStatus === "failed" ? t("The website preview could not load. Try again in a moment.") : t("Loading the website…")}
        </p>
      ) : page && facts ? (
        <Suspense fallback={null}>
          <SetupCanvas data={base} design={design} page={page} width={px} facts={facts} readerOnly={readerOnly} onBoxes={setBoxes} />
        </Suspense>
      ) : (
        <p className="ss-nothing">{pageKind === "note" ? t("No published note yet. Mark a note to publish, and it shows here.") : t("No tag with a published note yet.")}</p>
      )}
    </section>
  );
}
