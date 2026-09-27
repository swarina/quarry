import { describe, expect, it } from "vitest";
import { ashby } from "./ashby.ts";

const job = {
  id: "9638e78d-ada8-4111-832b-6d75eace719b",
  title: "Enterprise Business Development",
  department: "Go to Market",
  team: "Sales",
  employmentType: "FullTime",
  location: "Singapore",
  address: { postalAddress: { addressCountry: "Singapore", addressLocality: "Singapore" } },
  secondaryLocations: [
    {
      location: "US - New York",
      address: {
        postalAddress: {
          addressLocality: "New York",
          addressRegion: "New York",
          addressCountry: "United States",
        },
      },
    },
    { location: "Singapore" },
  ],
  publishedAt: "2026-08-17T03:58:42.064+00:00",
  isListed: true,
  isRemote: false,
  workplaceType: "OnSite",
  jobUrl: "https://jobs.ashbyhq.com/0g/9638e78d-ada8-4111-832b-6d75eace719b",
  applyUrl: "https://jobs.ashbyhq.com/0g/9638e78d-ada8-4111-832b-6d75eace719b/application",
  descriptionHtml: "<h1>Role</h1>",
  compensation: {
    compensationTierSummary: "CA$400K - CA$500K",
    summaryComponents: [
      { compensationType: "EquityPercentage", interval: "NONE", currencyCode: null },
      {
        compensationType: "Salary",
        interval: "1 YEAR",
        currencyCode: "CAD",
        minValue: 400_000,
        maxValue: 500_000,
      },
    ],
  },
};

describe("ashby", () => {
  it("maps a job, merging primary and secondary locations", () => {
    expect(ashby.mapJob(job, job.id)).toEqual({
      kind: "posting",
      posting: {
        externalId: job.id,
        title: "Enterprise Business Development",
        url: job.jobUrl,
        applyUrl: job.applyUrl,
        locations: ["Singapore", "US - New York"],
        places: [
          { label: "Singapore", text: "Singapore" },
          { label: "US - New York", text: "New York, United States" },
        ],
        country: null,
        workplace: "onsite",
        employmentType: "FullTime",
        department: "Go to Market",
        team: "Sales",
        language: null,
        publishedAt: Date.UTC(2026, 7, 17, 3, 58, 42, 64),
        salary: { min: 400_000, max: 500_000, currency: "CAD", interval: "year" },
        descriptionHtml: "<h1>Role</h1>",
      },
    });
  });

  it("pairs each label with its address, and never lets a malformed one invalidate the job", () => {
    const places = (overrides: Record<string, unknown>) => {
      const result = ashby.mapJob({ ...job, secondaryLocations: [], ...overrides }, job.id);
      return result.kind === "posting" ? result.posting.places : "invalid";
    };
    expect(
      places({
        location: "NAMER",
        address: {
          postalAddress: { addressRegion: "California", addressCountry: "United States" },
        },
      }),
    ).toEqual([{ label: "NAMER", text: "California, United States" }]);
    expect(places({ address: null })).toEqual([]);
    expect(places({ address: { postalAddress: {} } })).toEqual([]);
    expect(places({ address: "Singapore" })).toEqual([]);
    expect(places({ location: null })).toEqual([{ label: null, text: "Singapore" }]);
  });

  it("reads the declared workplace, falling back to isRemote", () => {
    const workplace = (workplaceType: unknown, isRemote: unknown) => {
      const result = ashby.mapJob({ ...job, workplaceType, isRemote }, job.id);
      return result.kind === "posting" ? result.posting.workplace : "invalid";
    };
    expect(workplace("Hybrid", true)).toBe("hybrid");
    expect(workplace("Remote", null)).toBe("remote");
    expect(workplace(null, true)).toBe("remote");
    expect(workplace(null, false)).toBeNull();
    expect(workplace(null, null)).toBeNull();
  });

  it("reads salary only from a Salary component it can interpret", () => {
    const salary = (summaryComponents: unknown) => {
      const result = ashby.mapJob({ ...job, compensation: { summaryComponents } }, job.id);
      return result.kind === "posting" ? result.posting.salary : "invalid";
    };
    expect(
      salary([
        { compensationType: "Salary", interval: "1 HOUR", currencyCode: "USD", minValue: 30 },
      ]),
    ).toEqual({ min: 30, max: null, currency: "USD", interval: "hour" });
    expect(
      salary([{ compensationType: "Bonus", interval: "1 YEAR", currencyCode: "USD" }]),
    ).toBeNull();
    expect(
      salary([{ compensationType: "Salary", interval: "NONE", currencyCode: "USD", minValue: 1 }]),
    ).toBeNull();
    expect(salary(null)).toBeNull();
  });

  it("skips jobs that are not publicly listed", () => {
    expect(ashby.mapJob({ ...job, isListed: false }, job.id)).toEqual({ kind: "unlisted" });
  });

  it("reports schema problems and empty titles as invalid", () => {
    expect(ashby.mapJob({ ...job, jobUrl: "javascript:alert(1)" }, job.id)).toEqual({
      kind: "invalid",
      problem: expect.stringMatching(/^jobUrl: /),
    });
    expect(ashby.mapJob({ ...job, title: "  " }, job.id)).toEqual({
      kind: "invalid",
      problem: "title: empty",
    });
  });

  it("never resolves API values to properties inherited from Object.prototype", () => {
    const result = ashby.mapJob(
      {
        ...job,
        workplaceType: "Constructor",
        isRemote: null,
        compensation: {
          summaryComponents: [
            {
              compensationType: "Salary",
              interval: "constructor",
              currencyCode: "USD",
              minValue: 1,
            },
          ],
        },
      },
      job.id,
    );
    expect(result.kind === "posting" && result.posting.workplace).toBeNull();
    expect(result.kind === "posting" && result.posting.salary).toBeNull();
  });
});
