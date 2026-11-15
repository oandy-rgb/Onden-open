import { Copy } from "lucide-react";

import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { Button } from "../../components/ui";

/** A connection code, shown once: the server keeps only a hash, so this is the only time it can be copied. */
export default function FreshKey({ name, plaintext, onDone, doneVariant = "ghost" }: {
  name: string; plaintext: string; onDone: () => void; doneVariant?: "ghost" | "primary";
}) {
  const t = useT();
  return (
    <div className="member-key-fresh" role="status">
      <strong>{name}</strong>
      <span>{t("Copy it now. It will never be shown again.")}</span>
      <code>{plaintext}</code>
      <div className="member-key-fresh-actions">
        <Button variant="secondary" size="sm" className="ai-touch" onClick={() => void copyText(plaintext, { what: "key" })}><Copy size={12} aria-hidden="true" /> {t("Copy")}</Button>
        <Button variant={doneVariant} size="sm" className="ai-touch" onClick={onDone}>{t("Done")}</Button>
      </div>
    </div>
  );
}
