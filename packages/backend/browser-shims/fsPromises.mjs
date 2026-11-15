// node:fs/promises in the browser app: the promise API of vfs.mjs.
import { promises } from "./vfs.mjs";
export const { mkdir, readdir, readFile, writeFile, rename, rm, unlink, stat, lstat, access, statfs, open, copyFile, chmod, appendFile, rmdir, mkdtemp, realpath } = promises;
export default promises;
