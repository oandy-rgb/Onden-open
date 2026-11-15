import { useRef, useState } from "react";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";

/** A field closes only after acknowledgement. Enter followed by blur shares
 * the pending attempt, rather than submitting the same draft twice. */
export function useFieldSave() {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  async function save(operation: () => Promise<unknown> | void): Promise<boolean> {
    if (pending.current) return false;
    pending.current = true; setSaving(true);
    try { await operation(); return true; }
    catch (error) { writeErrors.report(error, addToast); return false; }
    finally { pending.current = false; setSaving(false); }
  }
  return { save, saving };
}
