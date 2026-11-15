import { EyeOff } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { TagHide } from "./useTagHide";
import { Pressable } from "../ui";

/** The line saying a hidden tag is still working; the owner can unhide it here. */
export default function HiddenTagNote({ hide }: { hide: TagHide }) {
  const t = useT();
  if (!hide.hidden) return null;
  return (
    <p className="tag-page-hidden-note" role="status">
      <EyeOff size={13} aria-hidden="true" />
      <span>{t("This tag is hidden: notes keep it and it still works, but it is left out of tag lists, chips, suggestions and the website.")}</span>
      {hide.canHide && <Pressable type="button" onClick={() => hide.setHidden(false)}>{t("Unhide tag")}</Pressable>}
    </p>
  );
}
