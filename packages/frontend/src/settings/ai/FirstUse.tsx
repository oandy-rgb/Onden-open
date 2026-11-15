import { useState } from "react";

import { useT } from "../../lib/i18n";
import { Pressable } from "../../components/ui";
import NewConnectionFlow from "./NewConnectionFlow";
import type { AiPageData } from "./model";
import "./strings";

/** Nothing set up yet: one short explanation and two big choices. Whichever is finished makes one AI called “AI”
 *  (@ai) that uses the connection, switches the AI feature on, and starts suggest-only. */
export default function FirstUse({ data, online, aiOn, onDone, onFresh }: {
  data: AiPageData; online: boolean; aiOn: boolean;
  onDone: () => void; onFresh: (code: { aiName: string; plaintext: string }) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<"key" | "code" | null>(null);
  return (
    <section className="ai-first" aria-label={t("Set up AI")}>
      <p className="setting-note">{t("An AI can read the notes you let it, and suggest changes that wait for your yes. Choose how it connects. You can add more later.")}</p>
      {kind === null ? (
        <div className="ai-kinds" role="group" aria-label={t("Kind of connection")}>
          <Pressable className="ai-kind" disabled={!data.offered} onClick={() => setKind("key")}>
            <strong>{t("With an API key")}</strong>
            <small>{data.offered ? t("Write the address and the key, test it, and save.") : t("This server can't keep API keys yet.")}</small>
          </Pressable>
          <Pressable className="ai-kind" onClick={() => setKind("code")}>
            <strong>{t("Let your own AI connect in")}</strong>
            <small>{t("You get a connection code and the steps to put it into your own AI app.")}</small>
          </Pressable>
        </div>
      ) : (
        <NewConnectionFlow data={data} online={online} aiOn={aiOn} firstUse initialKind={kind} onDone={onDone} onFresh={onFresh} onCancel={() => setKind(null)} />
      )}
    </section>
  );
}
