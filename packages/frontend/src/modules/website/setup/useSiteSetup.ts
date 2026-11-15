// State of the website screen: the v3 design (boxes, style, css) with its autosave, and what the
// two website screens share (useSiteWork: notes, settings, publish). The design is the workspace
// chrome, saved whole through websiteWriter.saveSiteDesign with the same autosave, `rev` /
// design_stale handling and offline copy as the old home studio.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateDesign, type SiteDesign } from "@onden/site";
import type { Bootstrap } from "../../../lib/api";
import { nodeTagIds } from "../../../lib/nodeTags";
import type { SiteData } from "../../../components/siteFrame";
import { queueDesignSave } from "../studio/designAutosave";
import { useSiteWork } from "../studio/useHomeStudio";
import { homePublishBody } from "../usePublishReview";
import { sampleNoteId, sampleTagId, siteDataOfPreview } from "./previewSite";

type Options = { data: Bootstrap; online: boolean; refresh: () => Promise<void> };

/** How long the notes and settings rest before the preview is asked again. */
const candidatePause = 600;

export function useSiteSetup({ data, online, refresh }: Options) {
  const work = useSiteWork({ data, online, refresh });
  const { writer, autosave, notes } = work;

  // ── The design: the stored one, plus what this device has edited and not yet seen come back ──
  const stored = useMemo(() => validateDesign(data.chrome).design, [data.chrome]);
  const [design, setDesignState] = useState<SiteDesign>(stored);
  const designRef = useRef(design);
  const dirty = useRef(false);
  const sent = useRef<SiteDesign | null>(null);

  useEffect(() => {
    if (dirty.current) return;
    designRef.current = stored; setDesignState(stored);
  }, [stored]);

  const reloadAfterConflict = useCallback(async () => {
    try {
      const chrome = await writer.reloadDesign();
      dirty.current = false; sent.current = null;
      const next = validateDesign(chrome).design;
      designRef.current = next; setDesignState(next);
    } catch { /* not reached: the tab keeps its copy, and its next save is refused again and reloads */ }
    finally { autosave.discard("design"); }
  }, [writer, autosave]);

  const change = useCallback((move: (current: SiteDesign) => SiteDesign) => {
    const next = move(designRef.current);
    if (next === designRef.current) return;
    designRef.current = next; setDesignState(next);
    queueDesignSave(autosave, { dirty, sent }, next, (options) => writer.saveSiteDesign(next, options), () => { void reloadAfterConflict(); });
  }, [autosave, writer, reloadAfterConflict]);

  // ── The site as the server would publish it now ──
  // Asked again (after a pause) when what readers could see may have changed: which notes are on the
  // site, their text and tags, the site settings. The design is not asked: it is laid over this answer.
  const settings = work.settings.value;
  const publishedKey = useMemo(() => {
    const on = new Set(notes.filter((n) => n.published).map((n) => n.id));
    return JSON.stringify([
      data.nodes.filter((n) => on.has(n.id)).map((n) => [n.id, n.updated_at, nodeTagIds(n)]),
      (data.tags ?? []).map((tag) => [tag.id, tag.name]), data.edges.length, settings,
    ]);
  }, [notes, data.nodes, data.tags, data.edges.length, settings]);
  const [candidate, setCandidate] = useState<{ site: SiteData | null; status: "loading" | "ready" | "failed" }>({ site: null, status: "loading" });
  useEffect(() => {
    if (!online) return;
    let current = true;
    const timer = setTimeout(() => {
      writer.previewPublish(homePublishBody(settings)).then(
        (preview) => { if (current) setCandidate({ site: siteDataOfPreview(preview), status: "ready" }); },
        // Keep the last answer on screen; the screen says the preview could not be refreshed.
        () => { if (current) setCandidate((last) => ({ site: last.site, status: "failed" })); },
      );
    }, candidatePause);
    return () => { current = false; clearTimeout(timer); };
    // `publishedKey` stands for everything read above; `settings` is inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishedKey, online, writer]);
  const base = candidate.site;
  const sampleNote = useMemo(() => (base ? sampleNoteId(base) : null), [base]);
  const sampleTag = useMemo(() => (base ? sampleTagId(base) : null), [base]);

  return { ...work, design, change, base, previewStatus: candidate.status, sampleNote, sampleTag };
}

export type SiteSetupState = ReturnType<typeof useSiteSetup>;
