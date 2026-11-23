// State of the home studio: the design (a SiteDesignV2 v2) with its autosave,
// the notes and tags of this device, the publish review. The design is the
// workspace chrome, saved whole through websiteWriter.saveHomeDesign with the
// same autosave, `rev` / design_stale handling and offline copy as before.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PuckData, SiteDesignV2 } from "@onden/site";
import type { Bootstrap } from "../../../lib/api";
import { nodeNeedsBody } from "../../../lib/api";
import { addToast } from "../../../lib/appStore";
import { createAutosave, propertyWriter, reads, runBackgroundWrite, WriteActionError, type AutosaveStatus } from "../../../lib/data";
import { t } from "../../../lib/i18n";
import { useSpaces } from "../../../lib/spaces";
import { makeWebsiteWriter } from "../websiteWriter";
import { homePublishBody, reportIncluded, usePublishReview } from "../usePublishReview";
import { useSiteSettingsSave } from "../useSiteSettingsSave";
import { designFromChrome, isDesignChrome, sameDesign } from "./designModel";
import { queueDesignSave } from "./designAutosave";
import { blockedNotes, defaultDesignInputs, studioNotes, studioTags } from "./editorData";
import { PUBLISHED_ATTR } from "../publishBlocker";
import { onPageHide } from "../../../lib/pageHide";
import { nodeOf } from "../../../lib/nodeIndex";

const PUBLISHED_FLAG = { value_type: "bool" as const, is_inheritable: false };

type Options = { data: Bootstrap; online: boolean; refresh: () => Promise<void> };

/** Everything the website screens share, whichever page design they edit: the notes and tags of this
 *  device, the site's own settings, the autosave, and the publish flow (preview, confirm, include). */
export function useSiteWork({ data, online, refresh }: Options) {
  const latest = useRef({ online, refresh }); latest.current = { online, refresh };
  const [writer] = useState(() => makeWebsiteWriter({ online: () => latest.current.online, refresh: () => latest.current.refresh() }));
  const mounted = useRef(true);
  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>("idle");
  const [autosave] = useState(() => createAutosave((status) => { if (mounted.current) setSaveStatus(status); }));
  useEffect(() => {
    mounted.current = true;
    const flush = () => { void autosave.flush(true); };
    const stop = onPageHide(flush);
    return () => {
      stop();
      mounted.current = false;
      flush();
    };
  }, [autosave]);

  const { spaces } = useSpaces(online);
  const notes = useMemo(() => studioNotes(data.nodes, spaces), [data.nodes, spaces]);
  const blocked = useMemo(() => blockedNotes(data.nodes, spaces), [data.nodes, spaces]);
  const tags = useMemo(() => studioTags(data.nodes, data.tags ?? [], spaces), [data.nodes, data.tags, spaces]);
  const [siteSettings, setSiteSettings] = useSiteSettingsSave(data, writer, autosave);

  // ── Bodies the slim bootstrap left out, for the notes the page points at ──
  const [bodies, setBodies] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  const { nodes: allNodes } = data;
  const wantBodies = useCallback((ids: readonly string[]) => {
    for (const id of ids) {
      const node = nodeOf({ nodes: allNodes }, id);
      if (!node || !nodeNeedsBody(node) || asked.current.has(id)) continue;
      asked.current.add(id);
      void reads.notes.full(id).then(
        (full) => setBodies((prev) => new Map(prev).set(id, full.markdown ?? "")),
        () => { asked.current.delete(id); },
      );
    }
  }, [allNodes]);

  // ── Publish ──
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing" | "published" | "error">("idle");
  const publishing = useRef(false);
  const review = usePublishReview(writer);

  async function startPublish() {
    if (publishing.current) return;
    await review.start(async () => {
      if (!await autosave.flush()) throw new WriteActionError(t("Save the website changes before publishing."));
      return homePublishBody(siteSettings);
    });
  }
  /** True when the site went out. */
  async function confirmPublish(): Promise<boolean> {
    if (publishing.current) return false;
    publishing.current = true; setPublishStatus("publishing");
    try {
      const result = await review.confirm();
      if (!result) { setPublishStatus("error"); return false; }
      setPublishUrl(result.url); setPublishStatus("published");
      // A read failure after publication must not invite a duplicate publish.
      void refresh().catch(() => addToast(t("The change is saved. Refresh to load the latest details."), "info"));
      return true;
    } finally { publishing.current = false; }
  }
  /** 「一起發布」 from the review dialog or a suggestion; the local notes follow the server. */
  async function includeNotes(noteIds: string[]): Promise<boolean> {
    const done = review.pending ? await review.include(noteIds) : await writer.includeNotes(noteIds).then(reportIncluded, () => false);
    if (done) void refresh().catch(() => {});
    return done;
  }
  /** 「發布這篇」: puts the note on the site (「發布」, the same switch as the note's own button: a note kept off,
   *  blank or saved from a feed goes on); readers get it with the next Publish. */
  function publishNote(noteId: string) {
    runBackgroundWrite(propertyWriter.set(noteId, PUBLISHED_ATTR, "true", PUBLISHED_FLAG));
  }
  /** 「從網站移除」: keeps the note off the site (「不發布」, which wins over its space); the note itself stays. */
  function unpublishNote(noteId: string) {
    runBackgroundWrite(propertyWriter.set(noteId, PUBLISHED_ATTR, "false", PUBLISHED_FLAG));
  }

  return {
    online, writer, autosave, notes, tags, blocked,
    settings: { value: siteSettings, set: setSiteSettings },
    bodies, wantBodies,
    save: { status: saveStatus, retry: () => autosave.flush() },
    publish: {
      start: startPublish, pending: review.pending, outcome: review.outcome, loading: review.loading, confirm: confirmPublish,
      cancel: review.cancel, status: publishStatus, url: publishUrl, include: includeNotes, refresh: review.refresh,
    },
    publishNote, unpublishNote,
  };
}

export type SiteWork = ReturnType<typeof useSiteWork>;

/** The old home studio's state: the v2-shaped working copy of the free-form home page with its autosave. */
export function useHomeStudio(options: Options) {
  const { data } = options;
  const work = useSiteWork(options);
  const { writer, autosave, notes } = work;
  // ── The design ──
  // A chrome that is not v2 starts from the default design, which is saved on
  // the first change (never on open).
  const fallbackRef = useRef(defaultDesignInputs(notes, data.nodes, data.tags ?? [], data.workspace.home_node_id ?? null));
  const [start] = useState(() => designFromChrome(data.chrome, fallbackRef.current).design);
  const [design, setDesignState] = useState<SiteDesignV2>(start);
  const designRef = useRef(design);
  /** Bumped when the design is replaced from outside (another device), so the editor reloads its data. */
  const [designVersion, setDesignVersion] = useState(0);
  const dirty = useRef(false);

  const replaceDesign = useCallback((next: SiteDesignV2) => {
    designRef.current = next; setDesignState(next); setDesignVersion((v) => v + 1);
  }, []);

  // Another tab or device saved a newer design and nothing here is unsaved: follow it (D119).
  useEffect(() => {
    if (dirty.current || !isDesignChrome(data.chrome)) return;
    const { design: stored } = designFromChrome(data.chrome, fallbackRef.current);
    if (stored.rev === designRef.current.rev) return;
    // This tab's own save, back under the rev it was sent with: take the rev and
    // keep the editor as it is. Reloading it would drop the selected block.
    if (sameDesign(stored, designRef.current)) { designRef.current = { ...designRef.current, rev: stored.rev }; return; }
    replaceDesign(stored);
  }, [data.chrome, replaceDesign]);

  const sentDesign = useRef<SiteDesignV2 | null>(null);
  const scheduleSave = useCallback((next: SiteDesignV2) => {
    queueDesignSave(autosave, { dirty, sent: sentDesign }, next, (options) => writer.saveHomeDesign(next, options), () => { void reloadAfterConflict(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadAfterConflict only reads refs and stable setters
  }, [autosave, writer]);

  // The save was refused (the writer said so): show the current design and drop
  // this tab's edits made on the old one instead of sending them again.
  async function reloadAfterConflict() {
    try {
      const chrome = await writer.reloadDesign();
      dirty.current = false; sentDesign.current = null;
      replaceDesign(designFromChrome(chrome, fallbackRef.current).design);
    } catch { /* not reached: the tab keeps its copy, and its next save is refused again and reloads */ }
    finally { autosave.discard("design"); }
  }

  const changeDesign = useCallback((change: (current: SiteDesignV2) => SiteDesignV2) => {
    const next = change(designRef.current);
    if (next === designRef.current) return;
    designRef.current = next; setDesignState(next);
    scheduleSave(next);
  }, [scheduleSave]);

  const setHome = useCallback((home: PuckData) => changeDesign((d) => ({ ...d, home })), [changeDesign]);
  /** Replace the whole design from a suggestion; the editor reloads its data. */
  const applyDesign = useCallback((next: SiteDesignV2) => {
    designRef.current = next; setDesignState(next); setDesignVersion((v) => v + 1);
    scheduleSave(next);
  }, [scheduleSave]);

  return { ...work, design, designVersion, setHome, changeDesign, applyDesign };
}

export type HomeStudioState = ReturnType<typeof useHomeStudio>;
