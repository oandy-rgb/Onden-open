-- 158: 拿掉 Apache AGE 擴充。
--
-- 產品程式從未使用它（圖的需求用一般資料表＋WITH RECURSIVE），001 只是順手裝了。
-- 安全順序：這支遷移先上線（映像仍含 AGE，所以能 DROP），之後才換成不含 AGE 的映像。
--
-- 有 AGE 圖就停下：圖資料住在 ag_catalog 的資料表裡，DROP 會一併刪掉，這裡寧可讓遷移失敗
-- 也不刪資料；不用 CASCADE，別的東西還依賴它時 DROP 也會失敗。
-- 全新安裝（映像沒有 AGE）：沒有 ag_catalog，下面全是 no-op。
-- 查表要用 EXECUTE：寫成「表存在 AND EXISTS (SELECT … FROM 該表)」時，PL/pgSQL 會先解析整個條件，
-- 沒有 AGE 的庫（全新安裝）就因為表不存在而失敗。
DO $$
DECLARE graphs bigint;
BEGIN
  IF to_regclass('ag_catalog.ag_graph') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM ag_catalog.ag_graph' INTO graphs;
    IF graphs > 0 THEN
      RAISE EXCEPTION 'drop_age: ag_catalog.ag_graph still has graphs; refusing to drop the AGE extension. Export or remove the graphs first.';
    END IF;
  END IF;
END
$$;

-- 只在真的裝了才 DROP：伺服器若還預載 age（shared_preload_libraries）而擴充沒裝，
-- age 的掛鉤會讓 `DROP EXTENSION IF EXISTS age` 報「schema "ag_catalog" does not exist」。
-- 由 schema.sql 另外建立的 ag_catalog 不屬於擴充，DROP EXTENSION 不會帶走；
-- 不加 CASCADE：裡面還有東西就失敗，不靜默刪除。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'age') THEN
    EXECUTE 'DROP EXTENSION age';
  END IF;
  IF to_regnamespace('ag_catalog') IS NOT NULL THEN
    EXECUTE 'DROP SCHEMA ag_catalog';
  END IF;
END
$$;
