import { Globe } from "lucide-react";
import { t } from "../../lib/i18n";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { loadedSpaces } from "../../lib/spaces";
import type { NoteFunctionEnv, NoteFunctionRow } from "../types";
import { publishBlocker } from "./publishBlocker";
import { isNote } from "@onden/markdown/contract";

const PublishNoteRow = lazyWithReload(() => import("./PublishNoteRow"));

/** The 「網站」 row of the 功能 tab: for a note in a space that publishes (it is on the site, or kept off and
 *  can be put back), and only for someone who may edit it. The module draws the whole row (its status and
 *  buttons: PublishNoteRow). A hidden note or one in a space that does not publish gets none. */
export default function websiteNoteFunctionRows({ node, canEdit }: NoteFunctionEnv): NoteFunctionRow[] {
  return canEdit && isNote(node) && !publishBlocker(node, loadedSpaces())
    ? [{ id: "website", Icon: Globe, name: t("Website"), related: true, status: "", Custom: PublishNoteRow }] : [];
}
