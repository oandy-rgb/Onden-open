// Two checked values for the few places where SQL *text* (not a value) has to be built from a variable:
// a LIMIT whose number comes from a caller, a table or column name picked from a list. Values still go through
// `$n` parameters; these exist so the SQL-text guard (test/guards/allowlist, rule be-sql-interpolation) can tell a
// validated piece from an arbitrary string. Everything else a query template may embed is a constant or a
// registered fragment helper (owners.ts SQL_FRAGMENT_HELPERS).

/** An integer to write into SQL text (`LIMIT ${sqlInt(n)}`). Throws for NaN, fractions, Infinity or an unsafe integer. */
export function sqlInt(value: number): string {
  if (!Number.isSafeInteger(value)) throw new TypeError("sqlInt: not a safe integer");
  return String(value);
}

/** A table or column name to write into SQL text (`FROM ${sqlIdentifier(table)}`): lower-case letters, digits and
 *  underscores, not starting with a digit. Throws for anything else, so a name taken from a list or a field of a
 *  request cannot carry SQL. */
export function sqlIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new TypeError("sqlIdentifier: not a plain lower-case identifier");
  return name;
}
