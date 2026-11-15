import { useState } from "react";
import { Copy } from "lucide-react";

import { confirmDialog } from "../../components/ConfirmDialog";
import { Button } from "../../components/ui";
import { copyText } from "../../lib/clipboard";
import { useT } from "../../lib/i18n";
import { pageOrigin } from "../../lib/pageUrl";
import "./ai.css";
import "./strings";

/** The address the owner's AI software connects to. */
const connectAddress = (): string => `${pageOrigin()}/api/mcp/protocol`;

/** One value to copy: shown whole in a block that selects as one piece and wraps anywhere, with its own copy button. */
function CopyBlock({ value, label, what, primary, onCopied }: {
  value: string; label: string; what: "key" | "link"; primary: boolean; onCopied?: () => void;
}) {
  return (
    <>
      <code className="ai-secret">{value}</code>
      <Button variant={primary ? "primary" : "secondary"} size="sm" className="ai-touch ai-copy"
        onClick={() => void copyText(value, { what }).then((ok) => { if (ok) onCopied?.(); })}>
        <Copy size={12} aria-hidden="true" /> {label}
      </Button>
    </>
  );
}

/** What to do in the owner's own AI software with a connection code, as one numbered list where each step carries
 *  its own value. With `fresh` (the code was just made; the server keeps only a hash, so this is the only time it can
 *  be copied) step 1 holds the code, copying is the main action, and leaving before it was copied asks first.
 *  Without it (the 「怎麼接」 button on a card) step 1 says where the code is, and there is nothing to leave. */
export default function ConnectionCodeSteps({ fresh, onDone }: {
  fresh?: { aiName: string; plaintext: string }; onDone?: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function leave() {
    if (!copied && !(await confirmDialog(
      t("You haven't copied the connection code yet, and it can't be shown again. If you lose it, revoke it on the AI's card and make another. Leave anyway?"),
      { confirmLabel: t("Leave without copying"), danger: true }))) return;
    onDone?.();
  }

  return (
    <section className="ai-steps" role={fresh ? "status" : "group"} aria-label={fresh ? t("Connection code of {name}", { name: fresh.aiName }) : t("How to connect")}>
      {fresh && (
        <header className="ai-steps-head">
          <strong>{t("Connection code of {name}", { name: fresh.aiName })}</strong>
          <span>{t("Shown only this once. Copy it now.")}</span>
        </header>
      )}
      <ol>
        <li>
          {fresh ? t("Copy the connection code.") : t("Use the connection code you copied when it was made. Lost it? Choose “Revoke code”, then “Change connection”, to make another.")}
          {fresh && <CopyBlock value={fresh.plaintext} label={t("Copy connection code")} what="key" primary={!copied} onCopied={() => setCopied(true)} />}
        </li>
        <li>
          {t("In your AI software, add a new MCP server with this address:")}
          <CopyBlock value={connectAddress()} label={t("Copy address")} what="link" primary={false} />
        </li>
        <li>{t("When it asks for a key or token, paste the connection code.")}</li>
      </ol>
      <p className="ai-steps-note">{t("Using Onden's tools from your AI software works right away. Questions you ask inside Onden (in a note's AI tab, or with @) are answered only when a program on one of your computers keeps fetching them; a connection with just the address and code never does that by itself, so those questions wait and then fail. The self-hosting guide “Let an AI pick up work on its own machine” shows how.")}</p>
      {fresh && onDone && <div className="ai-steps-actions"><Button variant="secondary" size="sm" className="ai-touch" onClick={() => void leave()}>{t("Done")}</Button></div>}
    </section>
  );
}
