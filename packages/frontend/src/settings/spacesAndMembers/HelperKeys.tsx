import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound, ShieldOff } from "lucide-react";

import { addToast } from "../../lib/appStore";
import { reads, sendWrite, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import { Button, LoadError, Radio, TextField } from "../../components/ui";
import { FreshKey, revokeCode } from "../ai";
import type { RosterPerson } from "./roster";
import { spacesOf } from "./roster";

type KeyRow = { id: string; name: string; access: "read" | "write"; last_used_at: string | null; expires_at: string | null; revoked_at: string | null };
type Access = "read" | "write";

/** One AI helper's keys, inside its row: issue (唯讀 / 可寫), see the plaintext
 *  once, revoke. A key reaches exactly the spaces its helper is in, so a helper
 *  in no space cannot be given one — the form says so instead of making a key
 *  that reads nothing. */
export default function HelperKeys({ person, online, onChanged }: { person: RosterPerson; online: boolean; onChanged: () => void }) {
  const t = useT();
  const nameId = useId();
  const accessName = useId();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  // A failed read is not an empty list: the owner must not conclude there is nothing to revoke.
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [busy, setBusy] = useState(false);
  // The plaintext exists only here, only until it is dismissed: the server keeps a hash.
  const [fresh, setFresh] = useState<{ name: string; plaintext: string } | null>(null);
  const inSpaces = spacesOf(person);
  const canWriteSomewhere = Object.values(person.permissions).includes("edit");

  const load = useCallback(async () => {
    try {
      setKeys((await reads.people.actorTokens<KeyRow>(person.id)).filter((k) => !k.revoked_at));
      setLoadFailed(false);
    } catch { setLoadFailed(true); }
  }, [person.id]);
  useEffect(() => { void load(); }, [load]);

  async function issue() {
    if (inSpaces.length === 0 || busy) return;
    setBusy(true);
    const label = name.trim() || (access === "read" ? t("Read-only key") : t("Read and write key"));
    try {
      const minted = await sendWrite<{ token: string }>("POST", `/api/actors/${person.id}/tokens`, { name: label, access });
      setFresh({ name: label, plaintext: minted.token });
      setName("");
      await load();
      onChanged();
    } catch (error) { writeErrors.report(error, addToast); }
    finally { setBusy(false); }
  }

  async function revoke(key: KeyRow) {
    setBusy(true);
    const done = await revokeCode({ id: key.id, actorId: person.id, name: key.name });
    setBusy(false);
    if (!done) return;
    await load();
    onChanged();
  }

  return (
    <section className="member-keys" aria-label={t("Keys of {name}", { name: person.name })}>
      <h4><KeyRound size={13} aria-hidden="true" /> {t("Keys")}</h4>
      {fresh && <FreshKey name={fresh.name} plaintext={fresh.plaintext} onDone={() => setFresh(null)} />}
      {loadFailed && <LoadError online={online} onRetry={() => void load()} failed={t("Couldn't load the keys.")} />}
      {keys === null ? (loadFailed ? null : <p className="setting-note">{t("Loading…")}</p>) : keys.length === 0 ? (
        <p className="setting-note">{t("No keys yet.")}</p>
      ) : (
        <ul className="member-key-list">
          {keys.map((key) => (
            <li key={key.id}>
              <span className="member-key-name">{key.name || t("Unnamed key")}</span>
              <span className="member-key-meta">
                {key.access === "write" ? t("Read and write") : t("Read-only")}
                {" · "}
                {key.last_used_at ? t("Last used {date}", { date: dateLabel(key.last_used_at, "shortDateTime") }) : t("Never used")}
              </span>
              <Button variant="ghost" size="sm" disabled={!online || busy}
                aria-label={t("Revoke the key “{name}”", { name: key.name || t("Unnamed key") })} onClick={() => void revoke(key)}>
                <ShieldOff size={12} aria-hidden="true" /> {t("Revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {inSpaces.length === 0 ? (
        <p className="member-hint">{t("Put {name} in at least one space above first. A key reaches only the spaces its helper is in.", { name: person.name })}</p>
      ) : (
        <form className="member-key-form" onSubmit={(e) => { e.preventDefault(); void issue(); }}>
          <label htmlFor={nameId}>{t("Key name (optional)")}</label>
          <TextField id={nameId} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <div className="member-key-access" role="radiogroup" aria-label={t("What the key may do")}>
            <label><Radio name={accessName} checked={access === "read"} onChange={() => setAccess("read")} /> {t("Read-only: can look things up, changes nothing")}</label>
            <label><Radio name={accessName} checked={access === "write"} onChange={() => setAccess("write")} /> {t("Read and write: can add and change notes where {name} can edit", { name: person.name })}</label>
          </div>
          {access === "write" && !canWriteSomewhere && (
            <p className="member-hint" role="status">{t("{name} can only read in every space, so this key could not change anything. Give it “Can edit” in a space above.", { name: person.name })}</p>
          )}
          <Button type="submit" variant="secondary" disabled={!online || busy}>{t("Issue key")}</Button>
        </form>
      )}
    </section>
  );
}
