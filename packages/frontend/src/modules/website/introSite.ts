// The welcome card's "Build your first website" (the registry's sitePublisher):
// the publishing loop itself, self-demonstrating — the intro notes
// (data/introSite.ts) become a real published site.
//
// Under snapshot model B (docs/architecture/site-render-model.md) readers get
// only what a Publish froze, and only notes in a space whose `publish` switch
// is on (docs/architecture/spaces.md). So the pages are created in a space
// that publishes (the shared "Everyone" space first; a new note would
// otherwise land in "Only me", which never publishes), marked `_published`
// in the same request, given the intro name and navigation, and then published through
// the Studio's own preview → publish (websiteWriter). Only a publish that
// went out is announced and linked; anything else says why.
//
// Notes the user already has are never touched, whatever their title: the
// flow creates its own pages, and reuses only the ones it created itself
// earlier in this session (a retry after a failure; the remembered id is
// also the create's idempotency key, so a lost reply never makes a second set).

import { INTRO_HOME_TITLE, INTRO_PAGES, INTRO_SITE_CONFIG } from "../../data/introSite";
import { addToast, getAppState, getNode } from "../../lib/appStore";
import { isShownNote } from "../../lib/nodeTags";
import { noteWriter, propertyWriter, workspaceWriter, writeErrors, WriteActionError } from "../../lib/data";
import { t } from "../../lib/i18n";
import { siteSettingsFromConfig } from "../../lib/siteSettings";
import { loadedSpaces, refreshSpaces, type Space } from "../../lib/spaces";
import { randomUUID } from "../../lib/uuid";
import { PUBLISHED_ATTR } from "./publishBlocker";
import { homePublishBody } from "./usePublishReview";
import { makeWebsiteWriter } from "./websiteWriter";
import type { PublishPreview } from "@onden/contract";
import { canWriteSpace } from "../../lib/capabilities";

const PUBLISHED = { key: PUBLISHED_ATTR, value: "true", value_type: "bool" as const, is_inheritable: false };

/** The intro pages this flow created, by title (this session). */
const createdIds = new Map<string, string>();

/** For tests: forget the pages created earlier. */
export function resetIntroSiteForTest(): void {
  createdIds.clear();
}

/** Where the intro pages go: a space the caller may write whose `publish`
 *  switch is on — the default shared space first, then another shared one,
 *  then any (a personal space whose owner turned publishing on). */
export function introSiteSpace(spaces: readonly Space[]): Space | null {
  const usable = spaces.filter((s) => s.capabilities.publish === true && canWriteSpace(s));
  return usable.find((s) => s.is_default) ?? usable.find((s) => s.kind === "shared") ?? usable[0] ?? null;
}

/** Fails the build with a reason the toast shows. */
const refuse = (message: string) => new WriteActionError(message);

/** Whether the preview puts anything on the site (or takes anything off, or changes it) besides `own` notes. */
function alsoPublishesOthers(preview: PublishPreview, own: ReadonlySet<string>): boolean {
  const { added, changed, moved, links_changed, removed } = preview.diff;
  return [added, changed, moved, links_changed, removed].some((list) => list.some((n) => !own.has(n.id)))
    || (preview.new_media ?? []).some((m) => m.node_ids.some((id) => !own.has(id)));
}

/** What the first-site flow writes into the site settings: the name, tagline and accent, each only where the site has
 *  none yet, and never the language or the description. Those say who the site is for and what it is about, and the
 *  intro's are Onden's own (an English site whose description was the product blurb was what a Chinese-writing owner
 *  published). Language falls to the account's (siteSettings), the description to the home note's first line (the site). */
function introSiteConfig(existing: Record<string, unknown> | undefined | null): Pick<typeof INTRO_SITE_CONFIG, "brand" | "tagline" | "accent"> {
  const unset = (key: string) => typeof existing?.[key] !== "string" || existing[key] === "";
  const { brand, tagline, accent } = INTRO_SITE_CONFIG;
  return {
    brand: unset("brand") ? brand : String(existing!.brand),
    tagline: unset("tagline") ? tagline : String(existing!.tagline),
    accent: unset("accent") ? accent : String(existing!.accent),
  };
}

/** Builds and publishes the intro site. Resolves the published Home's link
 *  and id; `needsReview` when the publish would carry other notes too (the
 *  pages are ready and the Website screen's preview asks first); null when
 *  nothing was published (reported once, here or by the writer that failed). */
export async function buildIntroSite(): Promise<{ url: string; homeId: string } | { needsReview: true; homeId: string } | null> {
  try {
    await refreshSpaces();
    const space = introSiteSpace(loadedSpaces());
    if (!space) {
      throw refuse(t("None of your spaces publishes to the website, so the site would be empty. Ask the workspace owner to turn on publishing for a space, then try again."));
    }

    // 1. The pages, in the publishing space, marked for the site in the same
    //    request. The site is a snapshot of what the server has, so a page
    //    only queued on this device would be missing from it.
    const idByTitle: Record<string, string> = {};
    for (const page of INTRO_PAGES) {
      const earlier = createdIds.get(page.title);
      const earlierNode = getNode(earlier);
      const kept = earlierNode && isShownNote(earlierNode) ? earlierNode : undefined;
      if (kept) {
        if (kept.attrs?.[PUBLISHED.key] !== "true") {
          await propertyWriter.set(kept.id, PUBLISHED.key, PUBLISHED.value, { value_type: PUBLISHED.value_type, is_inheritable: false });
        }
        idByTitle[page.title] = kept.id;
        continue;
      }
      const id = earlier ?? randomUUID();
      createdIds.set(page.title, id);
      const { status } = await noteWriter.create({ id, title: page.title, markdown: page.markdown, space_id: space.id, attributes: [PUBLISHED] });
      if (status !== "synced") throw refuse(t("Publishing needs a connection."));
      idByTitle[page.title] = id;
    }
    const homeId = idByTitle[INTRO_HOME_TITLE];
    if (!homeId) return null;

    // 2. The site's name and navigation in page order, saved like the Studio
    //    saves them. No home design is written: the site publishes the server's
    //    default design until the owner makes one in the Studio.
    const nav = INTRO_PAGES.filter((p) => p.nav && idByTitle[p.title]).map((p) => ({ label: p.title, nodeId: idByTitle[p.title]! }));
    const before = getAppState().data;
    const design = await workspaceWriter.saveDesign({ config: { ...introSiteConfig(before.site_config), nav } });
    if (design.status !== "synced") throw refuse(t("Publishing needs a connection."));
    // The workspace's home is Home unless the user already chose one, so a
    // later Publish from the Studio keeps it. Not needed for this publish
    // (it names its home): a failure is reported by the writer and ignored.
    if (!before.workspace.home_node_id) await workspaceWriter.setHome(homeId).catch(() => {});

    // 3. Publish, the Studio's way: preview the candidate, then publish
    //    exactly that candidate by its hash.
    const writer = makeWebsiteWriter();
    const body = homePublishBody(siteSettingsFromConfig(getAppState().data.site_config), homeId);
    const preview = await writer.previewPublish(body);
    const home = ((preview.site.payload.nodes ?? []) as unknown[]).find((n): n is { id: string; slug?: string } => (n as { id?: unknown }).id === homeId);
    if (!home) throw refuse(t("The intro pages could not be put on the site. Check that their space allows publishing, then publish from the Website screen."));
    // A space that publishes puts all its notes on the site, so this publish can carry more than the pages made here.
    // Nobody confirmed that, and this flow shows no list: it goes to the Website screen's own preview instead.
    if (alsoPublishesOthers(preview, new Set(Object.values(idByTitle)))) {
      addToast(t("Publishing now would also put your other notes in that space on the site. Open the Website screen and press Publish to see the list first."), "info");
      return { needsReview: true, homeId };
    }
    await writer.publish({ ...body, preview_hash: preview.hash });

    addToast(t("You just published a website — every page is an ordinary Onden note. Edit or delete them any time."), "info");
    return { url: home.slug ? `/site/${home.slug}` : "/site/", homeId };
  } catch (error) {
    writeErrors.report(error, addToast);
    return null;
  }
}
