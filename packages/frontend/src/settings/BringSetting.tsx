// Settings › 你的資料 › 從另一台裝置帶過來: the browser version's half of "take my notes to another device"
// (the other half is DeviceFileSetting). It exists only where the app says it keeps notes on this device alone
// (lib/localOnlyStatus); a server's web app has no such door (a server is not an empty new device).

import { useT } from "../lib/i18n";
import { useLocalOnlyStatus } from "../lib/localOnlyStatus";
import { Button } from "../components/ui";
import { DataRow } from "./DataRow";

export function BringSetting() {
  const tr = useT();
  const bring = useLocalOnlyStatus()?.bringNotes;
  if (!bring) return null;
  return (
    <DataRow
      title={tr("Bring notes from another device")}
      hint={tr("Takes the file you made on your other device into this one, which must have no notes of its own. The two devices will not update each other afterwards.")}
      action={<Button type="button" variant="secondary" onClick={bring}>{tr("Bring notes…")}</Button>}
    />
  );
}
