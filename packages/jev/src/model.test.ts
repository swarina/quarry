import { describe, expect, it } from "vitest";
import { costNanoUsd, formatUsd } from "./model.ts";

describe("costNanoUsd", () => {
  it("charges $0.042 per million input tokens", () => {
    expect(costNanoUsd(1_000_000)).toBe(42_000_000);
    expect(formatUsd(costNanoUsd(1_000_000))).toBe("$0.042000");
  });

  it("stays an exact integer for any whole token count", () => {
    expect(Number.isInteger(costNanoUsd(1234))).toBe(true);
    expect(costNanoUsd(0)).toBe(0);
  });
});
