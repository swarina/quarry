import { describe, expect, it } from "vitest";
import {
  cleanList,
  cleanText,
  countryCode,
  escapeHtml,
  httpUrl,
  parseTimestamp,
  salaryRange,
} from "./fields.ts";

describe("cleanText", () => {
  it("collapses whitespace and maps empty values to null", () => {
    expect(cleanText("  Senior\n  Engineer ")).toBe("Senior Engineer");
    expect(cleanText("   ")).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });
});

describe("cleanList", () => {
  it("drops empty entries and duplicates, keeping the first order", () => {
    expect(cleanList(["Berlin", " ", null, "Remote ", "Berlin", undefined, "Remote"])).toEqual([
      "Berlin",
      "Remote",
    ]);
  });
});

describe("parseTimestamp", () => {
  it("parses ISO 8601 with offsets into epoch milliseconds", () => {
    expect(parseTimestamp("2026-08-19T12:29:00-04:00")).toBe(Date.UTC(2026, 7, 19, 16, 29));
    expect(parseTimestamp("2026-08-17T03:58:42.064+00:00")).toBe(
      Date.UTC(2026, 7, 17, 3, 58, 42, 64),
    );
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp("not a date")).toBeNull();
  });
});

describe("countryCode", () => {
  it("accepts two-letter codes in any case", () => {
    expect(countryCode("us")).toBe("US");
    expect(countryCode(" GB ")).toBe("GB");
  });

  it("rejects anything else", () => {
    for (const bad of ["USA", "U", "United States", "", null, undefined]) {
      expect(countryCode(bad)).toBeNull();
    }
  });
});

describe("salaryRange", () => {
  it("builds a range with an uppercase currency", () => {
    expect(salaryRange(65_000, 82_000, "usd", "year")).toEqual({
      min: 65_000,
      max: 82_000,
      currency: "USD",
      interval: "year",
    });
    expect(salaryRange(null, 40, "EUR", "hour")).toEqual({
      min: null,
      max: 40,
      currency: "EUR",
      interval: "hour",
    });
  });

  it("returns null without a currency, an interval, or any valid bound", () => {
    expect(salaryRange(1, 2, null, "year")).toBeNull();
    expect(salaryRange(1, 2, "dollars", "year")).toBeNull();
    expect(salaryRange(1, 2, "USD", undefined)).toBeNull();
    expect(salaryRange(null, undefined, "USD", "year")).toBeNull();
    expect(salaryRange(-5, Number.NaN, "USD", "year")).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml("R&D <Team>")).toBe("R&amp;D &lt;Team&gt;");
  });
});

describe("httpUrl", () => {
  it("accepts only http and https links", () => {
    expect(httpUrl.safeParse("https://jobs.lever.co/acme/1").success).toBe(true);
    expect(httpUrl.safeParse("javascript:alert(1)").success).toBe(false);
    expect(httpUrl.safeParse("ftp://example.com").success).toBe(false);
  });
});
