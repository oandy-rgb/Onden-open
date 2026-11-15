import { addToast } from "../appStore";
import { reportWriteFailure } from "./writeErrors";

/** Only for event handlers with no success-dependent continuation. Forms and
 * compound operations await the writer and retain their input on failure. */
export function runBackgroundWrite(operation: Promise<unknown> | void): void {
  void Promise.resolve(operation).catch((error) => reportWriteFailure(error, addToast));
}

export function backgroundWrite<Args extends unknown[]>(operation: (...args: Args) => Promise<unknown> | void): (...args: Args) => void {
  return (...args) => runBackgroundWrite(operation(...args));
}
