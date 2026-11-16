// 連線碼放哪：加密後寫進 <userData>/ai-answering.json（0600）。明文只在記憶體裡、只在回答迴圈運轉時存在，
// 不顯示、不進網頁的儲存、不寫記錄。加密由 Electron 的 safeStorage 提供（用系統鑰匙圈／DPAPI／Keychain），
// 這裡只收一個 cipher 介面，所以不需要 Electron 就能測。
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** @typedef {{ available(): boolean, encrypt(text: string): Buffer, decrypt(data: Buffer): string }} Cipher */
/** @typedef {"own" | "remote"} TargetKey */
/** @typedef {{ enabled: boolean, code: string | null, actorId?: string, codeId?: string, address?: string }} Target */

/** Electron 的 safeStorage 包成 cipher。Linux 沒有鑰匙圈時 Electron 退回明文等級的 basic_text：那不算保護，視為不可用。 @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string, getSelectedStorageBackend?: () => string }} safeStorage @returns {Cipher} */
export function safeStorageCipher(safeStorage) {
  return {
    available: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text",
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

/** @param {{ file: string, cipher: Cipher }} options */
export function createAiAnsweringStore({ file, cipher }) {
  /** @returns {Record<string, { enabled?: boolean, cipher?: string, actorId?: string, codeId?: string, address?: string }>} */
  function readRaw() {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  }
  /** @param {Record<string, unknown>} data */
  function write(data) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }

  return {
    available: () => cipher.available(),
    /** 讀出一個對象。解不開（鑰匙圈換了、檔案壞了）就當沒有碼：關著，不丟錯。 @param {TargetKey} key @returns {Target} */
    get(key) {
      const entry = readRaw()[key] ?? {};
      let code = null;
      if (entry.cipher && cipher.available()) {
        try { code = cipher.decrypt(Buffer.from(entry.cipher, "base64")); } catch { code = null; }
      }
      return { enabled: entry.enabled === true && code !== null, code, actorId: entry.actorId, codeId: entry.codeId, address: entry.address };
    },
    /** 存下碼並設為開著。codeId 是伺服器上這把碼的編號（不是秘密），關掉時只作廢它。 @param {TargetKey} key @param {{ code: string, actorId?: string, codeId?: string, address?: string }} value */
    saveEnabled(key, { code, actorId, codeId, address }) {
      if (!cipher.available()) throw new Error("secure_storage_unavailable");
      write({ ...readRaw(), [key]: { enabled: true, cipher: cipher.encrypt(code).toString("base64"), actorId, codeId, address } });
    },
    /** 忘掉碼並設為關著。自己的 AI 的 id 留著（下次打開沿用同一個 AI）；別台伺服器的網址不留。 @param {TargetKey} key */
    forgetCode(key) {
      const entry = readRaw()[key] ?? {};
      write({ ...readRaw(), [key]: key === "own" ? { enabled: false, actorId: entry.actorId } : { enabled: false } });
    },
  };
}
