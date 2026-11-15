// repo 根目錄的唯一來源：由這個檔案自己的位置推出（scripts/lib/ 往上兩層），
// 不靠 cwd、不靠 git，也不在各腳本裡數 `../`。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
