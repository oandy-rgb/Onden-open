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
// 4 (anchors replicated, migration 215): the paragraph anchor table, each note's one anchors unit (note_anchor_places) and block_nodes are stamped tables of UNIT_SOURCES
// (block_node_tags travels with them), and a snapshot carries their stamps
// (spine/snapshotTables.json): a node of version 3 would refuse a bundle's anchor rows as an unknown table and read a snapshot's anchors as rows without stamps.
// 5 (a note's space follows its tree, migration 218): the `space` unit of content_nodes is the space a person WROTE (written_space_id), and space_id is derived
// from the tree after a merge; a snapshot carries both columns. A node of version 4 would merge space_id as the unit and read the `space` stamps of notes under
// a parent as the space they are in: the two would derive different spaces from the same stamps.
// 6 (a snapshot from a node that holds other origins, per-label progress; migration 222): `have`, and a change bundle's `base`, `upTo` and `holds`, are per label and
// origin ({ label: { origin: n } }, spine/stampedBundle.ts Have) instead of one number per origin (the least over every label); a snapshot page and the hello of a
// snapshot stream carry `brought`, the other origins the source holds with those numbers, and a joiner takes stamps of them. A node of version 5 would read a
// per-label header as origins named like labels, and refuse a snapshot's brought stamps one by one (`join_stamp_origin`) instead of saying why.
// 7 (a row that is not on a node keeps only its `*`; no migration): a node that does not hold a row of a table that keeps no values (dbRows.ts `dropFieldUnits`,
// stampedMerge/README 「沒有那一列的欄位跟著 `*`」) stores no field unit of it, so neither its snapshot nor its bundles carry one. The wire types are unchanged, but a
// node of version 6 stores, and sends, a stamp and a head for each field of such a row: the two would hold different units of the same writes for ever, with
// nothing refused.
// 8 (the values a note's text gives it travel, migration 223, batch 4a): node_attributes rows whose source is `markdown` or `frontmatter` are units, carried by a
// snapshot and a change bundle (spine/attributeSource.ts STAMPED_ATTRIBUTE_SOURCES). A node of version 7 holds such a row as no unit: it would make the carried row
// again over its own (a unique clash on (node, key)) and leave it out of what it sends.
// 9 is taken by the history batch 3 (issue #1971).
// 10 (own-node transport batch 5, migrations 235–): a note's `slug` is a unit (written_slug, the slug its write chose; the slug a node shows is settled from the
// units, spine/noteSlugs.ts), and the tables a snapshot carried with genesis stamps only travel by bundle too (stampedMerge/dbUnits.ts UNIT_SOURCES). A node of
// version 8 or 9 would refuse those labels (`bundle_scope`) and read a bundle's slug as no unit.
export const SYNC_DATA_SHAPE_VERSION = 10;
