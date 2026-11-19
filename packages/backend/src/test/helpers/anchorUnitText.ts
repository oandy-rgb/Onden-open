/** A note's anchors unit as its writer's database writes it (jsonb's text form: keys by length and then bytes, ", " and ": " between, migration 215): what a writer
 *  sends, so a test that builds or changes a unit gets past the received-unit check's form rule (spine/stampedMerge/anchorUnit.ts parseAnchorUnit) to the rule it is about. */
export function anchorUnitJson(unit: { h: string; a: Record<string, readonly unknown[]> }): string {
  const byKey = (x: string, y: string) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
  const a = unit.a;
  return `{"a": {${Object.keys(a).sort(byKey).map((k) => `${JSON.stringify(k)}: [${a[k]!.map((v) => JSON.stringify(v)).join(", ")}]`).join(", ")}}, "h": ${JSON.stringify(unit.h)}}`;
}
