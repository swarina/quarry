import type { NormalizedPosting } from "@quarry/domain";
import { describe, expect, it } from "vitest";
import { annualPay, deriveFacets, type EmploymentType, employmentTypes } from "./structured.ts";

function posting(overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    externalId: "1",
    title: "Engineer",
    url: "https://example.com/jobs/1",
    applyUrl: null,
    locations: [],
    places: [],
    country: null,
    workplace: null,
    employmentType: null,
    department: null,
    team: null,
    language: null,
    publishedAt: null,
    salary: null,
    descriptionHtml: "<p>Role</p>",
    ...overrides,
  };
}

describe("employmentTypes", () => {
  // Every label the listed postings used on 2026-09-27, but for program names.
  it.each<[string, EmploymentType[]]>([
    ["FullTime", ["full-time"]],
    ["PartTime", ["part-time"]],
    ["Intern", ["internship"]],
    ["Contract", ["contract"]],
    ["Temporary", ["temporary"]],
    ["Full-time", ["full-time"]],
    ["Full Time Employee", ["full-time"]],
    ["Full Time/Part Time", ["full-time", "part-time"]],
    ["Full-time: Remote", ["full-time"]],
    ["Permanent, Full-time", ["full-time"]],
    ["Employee - Permanent", ["full-time"]],
    ["CDI", ["full-time"]],
    ["Contract, Full-time", ["full-time", "contract"]],
    ["Full Time Contractor", ["full-time", "contract"]],
    ["Internship", ["internship"]],
    ["FR Intern", ["internship"]],
    ["Trainee", ["internship"]],
    ["Working Student", ["part-time"]],
    ["Fixed-term", ["temporary"]],
    ["Temp Full-time", ["full-time", "temporary"]],
    ["Temporary - 6 to 12 months with benefits", ["temporary"]],
    ["Short Term", ["temporary"]],
    ["Freelancer", ["contract"]],
    ["Project - Based", ["contract"]],
    ["FR Executive/Cadre", ["full-time"]],
    ["GE Employee", ["full-time"]],
    // An employee word names full-time only when nothing else names a type.
    ["Part Time Employee", ["part-time"]],
    ["Permanent Part-time", ["part-time"]],
    ["Temporary, Part-time", ["part-time", "temporary"]],
  ])("reads %s", (label, types) => {
    expect(employmentTypes(label)).toEqual(types);
  });

  it("names nothing for programs, entities, and missing labels", () => {
    for (const label of ["Binance Accelerator Program", "International EOR", "Hourly"]) {
      expect(employmentTypes(label)).toEqual([]);
    }
    expect(employmentTypes(null)).toEqual([]);
  });
});

describe("annualPay", () => {
  it("converts a stated range to a year, keeping the currency and stated period", () => {
    const pay = (min: number | null, max: number | null, interval: "year" | "month" | "hour") =>
      annualPay({ salary: { min, max, currency: "EUR", interval } });
    expect(pay(60_000, 80_000, "year")).toEqual({
      min: 60_000,
      max: 80_000,
      currency: "EUR",
      statedPer: "year",
    });
    expect(pay(5_000, null, "month")).toEqual({
      min: 60_000,
      max: null,
      currency: "EUR",
      statedPer: "month",
    });
    expect(pay(null, 45.5, "hour")?.max).toBe(94_640);
    expect(annualPay({ salary: null })).toBeNull();
  });
});

describe("deriveFacets", () => {
  it("combines location, arrangement, employment, and pay", () => {
    const facets = deriveFacets(
      posting({
        locations: ["Berlin, Germany", "Munich, Germany", "Remote - Germany"],
        employmentType: "Full-time",
        salary: { min: 5_000, max: 6_000, currency: "EUR", interval: "month" },
        department: "Engineering",
        publishedAt: 1_790_000_000_000,
      }),
      { country: "DE" },
    );
    expect(facets.countries).toEqual(["DE"]);
    expect(facets.location.places).toHaveLength(3);
    expect(facets).toMatchObject({
      workplace: "remote",
      employmentTypes: ["full-time"],
      pay: { min: 60_000, max: 72_000, currency: "EUR", statedPer: "month" },
      department: "Engineering",
      publishedAt: 1_790_000_000_000,
    });
  });

  it("prefers the arrangement the ATS states in a field over the labels'", () => {
    const facets = deriveFacets(posting({ locations: ["Remote - US"], workplace: "hybrid" }), {
      country: null,
    });
    expect(facets.workplace).toBe("hybrid");
    expect(facets.location.workplace).toBe("remote");
  });

  it("uses the company's home country as the last hint", () => {
    const cambridge = (country: string | null) =>
      deriveFacets(posting({ locations: ["Cambridge"] }), { country }).countries;
    expect(cambridge("US")).toEqual(["US"]);
    expect(cambridge("GB")).toEqual(["GB"]);
  });
});
