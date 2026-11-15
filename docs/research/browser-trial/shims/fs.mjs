// fs / fs/promises 的替身。
//  - 遷移檔：db.ts 的 migrate() 用 readdir/readFile 讀 db/migrations；這裡由建置時內嵌的清單回答（virtual:migrations）。
//  - 其他一律「不存在」(ENOENT) 或拋錯：auth 密鑰檔、媒體資料夾、備份暫存檔等。試用版的對應功能要另外實作（README §1 表）。
import * as mig from "virtual:migrations";
const list = mig.default;
const enoent = (n, p) => { const e = new Error(`ENOENT: ${n} ${p ?? ""} (not available in the browser trial)`); e.code = "ENOENT"; return e; };
const notAvail = (n) => () => { throw enoent(n); };
export async function readdir(dir) { if (String(dir).endsWith("db/migrations")) return list.map(([v]) => v + ".sql"); throw enoent("readdir", dir); }
export async function readFile(path) { const m = /([^/]+)\.sql$/.exec(String(path)); const hit = m && list.find(([v]) => v === m[1]); if (hit) return hit[1]; throw enoent("readFile", path); }
export const access = notAvail("access"), appendFileSync = notAvail("appendFileSync"), chmodSync = () => {}, createReadStream = notAvail("createReadStream"),
  createWriteStream = notAvail("createWriteStream"), existsSync = () => false, mkdir = async () => {}, mkdirSync = () => {}, mkdtemp = notAvail("mkdtemp"), mkdtempSync = notAvail("mkdtempSync"),
  open = notAvail("open"), readFileSync = (p) => { throw enoent("readFileSync", p); }, readdirSync = (p) => { throw enoent("readdirSync", p); }, rename = notAvail("rename"),
  rm = async () => {}, rmSync = () => {}, rmdirSync = () => {}, stat = notAvail("stat"), statSync = notAvail("statSync"), statfs = notAvail("statfs"), unlink = async () => {},
  unlinkSync = () => {}, utimesSync = () => {}, writeFile = notAvail("writeFile"), writeFileSync = notAvail("writeFileSync"), writeSync = notAvail("writeSync");
export default { readdir, readFile, existsSync, readFileSync, writeFileSync, mkdirSync };
