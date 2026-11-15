-- 實驗：用純 SQL 在 PGlite 上補出後端 nodeSearch.ts 用到的三個 pgroonga 介面，讓「沒改過的」nodeSearch.ts 能跑。
--   &@~                                  比對（詞、"片語"、OR、-排除；由左到右，OR 的優先序與 pgroonga 的差異：未查證）
--   pgroonga_query_extract_keywords(q)   摘要用關鍵字（排除與 OR 不算）
--   pgroonga_score(oid, tid)             相關性：此實驗固定 0（排序退回「標題相同／開頭相同」兩層，見 README §4）
-- 注意：函式內的 position() 用不到 GIN trigram 索引，是循序掃描；有索引的寫法見 search-bench.mjs（那才是正式的 trigramEngine 方向）。
CREATE OR REPLACE FUNCTION onden_match(doc text, q text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tok text; t text; neg boolean; hit boolean; res boolean; pending_or boolean := false; hay text := lower(coalesce(doc, ''));
BEGIN
  FOR tok IN SELECT m[1] FROM regexp_matches(q, '("[^"]*"|\S+)', 'g') AS m LOOP
    IF upper(tok) = 'OR' THEN pending_or := true; CONTINUE; END IF;
    neg := left(tok, 1) = '-' AND length(tok) > 1;
    t := lower(trim(both '"' from CASE WHEN neg THEN substr(tok, 2) ELSE tok END));
    IF t = '' THEN CONTINUE; END IF;
    hit := position(t IN hay) > 0;
    IF neg THEN hit := NOT hit; END IF;
    IF res IS NULL THEN res := hit; ELSIF pending_or THEN res := res OR hit; ELSE res := res AND hit; END IF;
    pending_or := false;
  END LOOP;
  RETURN coalesce(res, false);
END $$;
CREATE OPERATOR &@~ (LEFTARG = text, RIGHTARG = text, FUNCTION = onden_match);
CREATE OR REPLACE FUNCTION pgroonga_query_extract_keywords(q text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tok text; out text[] := '{}';
BEGIN
  FOR tok IN SELECT m[1] FROM regexp_matches(q, '("[^"]*"|\S+)', 'g') AS m LOOP
    IF upper(tok) = 'OR' OR (left(tok, 1) = '-' AND length(tok) > 1) THEN CONTINUE; END IF;
    out := out || trim(both '"' from tok);
  END LOOP;
  RETURN out;
END $$;
CREATE OR REPLACE FUNCTION pgroonga_score(tbl oid, rowid tid) RETURNS float8 LANGUAGE sql IMMUTABLE AS 'SELECT 0::float8';
