// The version of the SHAPE of replicated data: which units a row has, what a stamp's `saw` and `meta` mean, how a value is written as text,
// what a snapshot or a change bundle carries. Two nodes exchange only when their versions are equal: a snapshot file names it on its first line
// (services/stampedSnapshotStream.ts `hello`), every snapshot page and change bundle names it too, and a receiver that has another one refuses the
// whole thing (`join_data_shape`, `bundle_data_shape`).
//
// BUMP IT when a migration rewrites the shape of replicated data: a column that is a unit changes its type or text form, a unit is added to or
// removed from src/spine/stampedMerge/dbUnits.ts UNIT_SOURCES, the meaning of `saw` or `meta` changes, or a wire type of spine/snapshotSql.ts changes
// in a way an older reader would misread. Do NOT bump it for a migration that only adds a table nobody replicates or an index. A node that is a
// version behind has to take a snapshot (after it is upgraded), never a bundle: that is what the refusal is for.
// 2 (batch 2b-2a): a change bundle carries every table of UNIT_SOURCES and the keys of JSON_SOURCES (scope "stamped" instead of "content_nodes"; a row of another table, the keys of
// a JSON column as `<label>:<field>` texts, and a stamp of a row that is not in the table travel), so a node of version 1 would misread one. A snapshot page is unchanged, but carries the number too.
// 3 (restore renews the node id, migration 214): a snapshot page and the hello of a snapshot stream carry `former`, the ids the source had before it was
// restored, and the stamps of those ids travel as the source's own. A node of version 2 would refuse them one by one (`join_stamp_origin`) instead of saying why.
export const SYNC_DATA_SHAPE_VERSION = 3;
