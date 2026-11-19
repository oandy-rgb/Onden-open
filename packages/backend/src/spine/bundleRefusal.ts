// How a change bundle is refused: a coded status error (409 by default) the route turns into its code. Its own file because the merge core (stampedMerge/dbRows.ts) refuses
// a bundle too, and spine/stampedBundle.ts (the reader) imports the merge core: one definition, no import cycle.
import { CodedStatusError } from "../statusError.js";

class BundleRefused extends CodedStatusError {}
export const bundleRefused = (code: string, message: string, status: 400 | 409 | 422 = 409) => new BundleRefused(status, code, message);
