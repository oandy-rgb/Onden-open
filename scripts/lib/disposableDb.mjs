// 會被清空、重建或灌資料的資料庫（整合測試 _test、bench _bench、還原演練 _drill）的唯一護欄。
// 名稱規則與「只准本機」只在這裡寫；bash 腳本（restore-drill.sh、test-isolated.sh）各留一份
// 同規則的檢查，守門測試 dup-b2-test-helpers.guard.test.ts 擋住其他地方再自己寫。

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]']);

/** 網址裡的資料庫名稱；沒有網址或網址壞掉回 ""（不丟例外）。 */
export function databaseName(url) {
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/** 網址的主機是不是本機。壞網址一律不是。 */
export function isLocalDatabaseHost(url) {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 資料庫名稱以 `_<suffix>` 結尾（test／bench／drill）；`localOnly` 時主機還必須是本機。 */
export function isDisposableDatabase(url, suffix, { localOnly = false } = {}) {
  if (!new RegExp(`^[A-Za-z0-9_]+_${suffix}$`).test(databaseName(url))) return false;
  return !localOnly || isLocalDatabaseHost(url);
}

/** 不是拋棄式資料庫就丟例外（訊息不含連線密碼）。回傳資料庫名稱。 */
export function assertDisposableDatabase(url, suffix, { localOnly = false } = {}) {
  if (!isDisposableDatabase(url, suffix, { localOnly })) {
    const where = localOnly ? '本機、' : '';
    throw new Error(`拒絕動這個資料庫（"${databaseName(url)}"）：只接受${where}名稱以 _${suffix} 結尾的資料庫`);
  }
  return databaseName(url);
}
