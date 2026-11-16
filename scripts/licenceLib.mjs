// The licence policy's one rule (scripts/thirdPartyNotices.mjs applies it; scripts/licence-policy-baseline.json is the policy).

const named = (patterns, name) => patterns.some((pattern) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern));

/** Whether `name` may be used under the SPDX expression `licence`: with OR one side is enough (we take that one),
 *  with AND every side must hold. A conditional licence holds only for the packages it names. Anything the
 *  expression grammar does not cover is refused. */
export function allows(policy, licence, name) {
  const tokens = licence.match(/\(|\)|\bAND\b|\bOR\b|[^()\s]+(?:\s+(?!AND\b|OR\b)[^()\s]+)*/g) ?? [];
  let at = 0;
  const leaf = () => {
    if (tokens[at] === "(") { at++; const inner = either(); return tokens[at++] === ")" && inner; }
    const id = tokens[at++];
    return id !== undefined && id !== ")" && (policy.allowed.includes(id) || named(policy.conditional[id]?.packages ?? [], name));
  };
  const both = () => { let ok = leaf(); while (tokens[at] === "AND") { at++; ok = leaf() && ok; } return ok; };
  const either = () => { let ok = both(); while (tokens[at] === "OR") { at++; ok = both() || ok; } return ok; };
  const ok = either();
  return ok && at === tokens.length;
}
