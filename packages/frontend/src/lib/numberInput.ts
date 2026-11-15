// What a person types into a number cell is not always the stored grammar
// (NUMBER_PATTERN: optional minus, digits, optional decimal part): phones and
// IMEs give full-width digits, people write 1,200 or "1 200". tidyNumberInput
// turns those into the stored form; anything still not a number comes back
// unchanged so the caller can say so beside the cell instead of sending it.
import { isStoredNumber } from "@onden/markdown";

export function tidyNumberInput(raw: string): string {
  const s = raw.normalize("NFKC").replace(/[,，\s]/g, "").replace(/^[−–]/, "-");
  return isStoredNumber(s) ? s : raw.trim();
}
