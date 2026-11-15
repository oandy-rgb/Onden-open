import { useT } from "../../lib/i18n";
import { FieldError } from "./FieldError";
import { Pressable } from "./Pressable";

/** A "couldn't load" line with its Try again, for a read that failed (so it never
 *  looks like an empty list). Offline, it says the server can't be reached instead,
 *  so a dropped connection doesn't read as a broken screen. `failed` is what
 *  to say online ("Couldn't load the keys."); `message` replaces the text in
 *  every case (Try again stays). */
export function LoadError({ online, onRetry, failed, message }: { online: boolean; onRetry: () => void; failed?: string; message?: string }) {
  const t = useT();
  const text = message ?? (online ? failed ?? t("Couldn't load this.") : t("Could not reach the server. Try again when the connection is available."));
  return (
    <FieldError>
      {text}{" "}
      <Pressable type="button" className="ui-error-retry" onClick={onRetry}>{t("Try again")}</Pressable>
    </FieldError>
  );
}
