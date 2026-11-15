// Imported FIRST by main.tsx: modules evaluate in import order, and a temporary session (`?temp=1`) has to replace the
// page's storage before any module of the app can read it (lib/temporaryStorage.ts).
import { beginTemporarySessionIfAsked } from "../lib/temporaryStorage";

beginTemporarySessionIfAsked();
