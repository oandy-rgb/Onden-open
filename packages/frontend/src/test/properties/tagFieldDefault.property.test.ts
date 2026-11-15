// The tag field editor's default (scan 06 S4): whatever the options list becomes and whatever is typed into a
// number default, the default that is saved is one the server accepts.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { numberDefaultFrom, selectOptionsPatch } from "../../lib/tagFields";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const check = <T>(property: fc.IPropertyWithHooks<T>) => fc.assert(property, { seed: PROPS_SEED, numRuns: PROPS_RUNS });

const word = fc.constantFrom<string>("todo", "doing", "done", "gone");

describe("select options keep a default that is one of them", () => {
  it("random option lists and defaults", () => {
    check(fc.property(fc.uniqueArray(word), fc.option(word, { nil: undefined }), (options, seeded) => {
      const patch = selectOptionsPatch({ default: seeded }, options);
      expect(patch.options).toEqual(options);
      expect(patch.default === undefined || options.includes(patch.default)).toBe(true);
      if (seeded !== undefined && options.includes(seeded)) expect(patch.default).toBe(seeded);
    }));
  });

  it("S4: removing the option the default points at clears the default", () => {
    expect(selectOptionsPatch({ default: "doing" }, ["todo", "done"]).default).toBeUndefined();
    expect(selectOptionsPatch({ default: "todo" }, ["todo", "done"]).default).toBe("todo");
  });
});

describe("number default", () => {
  it("random typed text: a plain number is kept, anything else is no default", () => {
    check(fc.property(fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }).map(String), fc.string()), (raw) => {
      const kept = numberDefaultFrom(raw);
      if (kept !== undefined) expect(kept).toBe(raw);
      expect(kept !== undefined).toBe(/^-?\d+(\.\d+)?$/.test(raw));
    }));
  });

  it("S4: 1e3 is not a default", () => {
    expect(numberDefaultFrom("1e3")).toBeUndefined();
    expect(numberDefaultFrom("-2.5")).toBe("-2.5");
  });
});
