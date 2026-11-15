import { describe, expect, it } from "vitest";
import { tidyNumberInput } from "../lib/numberInput";

describe("tidyNumberInput", () => {
  it("accepts thousands separators, spaces and full-width digits", () => {
    expect(tidyNumberInput("1,200")).toBe("1200");
    expect(tidyNumberInput("１，２００.５")).toBe("1200.5");
    expect(tidyNumberInput(" 65 ")).toBe("65");
    expect(tidyNumberInput("−3")).toBe("-3");
  });
  it("leaves what is not a number as typed, for the caller to refuse", () => {
    expect(tidyNumberInput("abc")).toBe("abc");
    expect(tidyNumberInput("1e3")).toBe("1e3");
  });
});
