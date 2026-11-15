// What a background job (an outbox effect) is called to the user. The backend
// kinds are internal identifiers; every screen that names a job goes through
// here, and a kind with no name yet reads "Background job", never the kind.

import { t } from "./i18n";

const EFFECT_KIND_LABELS: Record<string, string> = {
  git_commit: "Local backup copy",
  github_backup: "GitHub backup",
  pages_push: "Website deploy",
  site_bundle: "Website download copy",
  site_rebuild: "Website update",
  tag_pack: "Tag pack install",
  rss_fetch: "Feed refresh",
  embed: "Search index",
};

export function effectKindLabel(kind: string): string {
  return t(EFFECT_KIND_LABELS[kind] ?? "Background job");
}
