// node:fs in the browser app: vfs.mjs (an in-memory file system). See there for what it is for.
import * as vfs from "./vfs.mjs";
export * from "./vfs.mjs";
export default { ...vfs };
