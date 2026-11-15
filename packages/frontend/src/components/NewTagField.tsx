import { useState } from "react";
import { t } from "../lib/i18n";
import { isEnterKey, isEscapeKey } from "../lib/keys";
import { TextField } from "./ui";

/** The "+" on the tag lists: a tag starts as just a NAME (D6); fields, access
 *  and automation grow later on the tag page the caller navigates to. */
export function useNewTag(onCreateTag?: (name: string) => Promise<void> | void) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy || !onCreateTag) return;
    setBusy(true);
    try {
      await onCreateTag(trimmed);
      setName("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }
  return {
    available: !!onCreateTag, open, name, busy, setName, submit,
    toggle: () => setOpen((o) => !o),
    cancel: () => { setOpen(false); setName(""); },
  };
}

export function NewTagField({ newTag }: { newTag: ReturnType<typeof useNewTag> }) {
  if (!newTag.open || !newTag.available) return null;
  return (
    <TextField
      className="sidebar-tag-new-input"
      autoFocus
      placeholder={t("New tag name…")}
      aria-label={t("New tag name…")}
      value={newTag.name}
      disabled={newTag.busy}
      onChange={(e) => newTag.setName(e.target.value)}
      onKeyDown={(e) => {
        if (isEnterKey(e)) void newTag.submit();
        if (isEscapeKey(e)) newTag.cancel();
      }}
    />
  );
}
