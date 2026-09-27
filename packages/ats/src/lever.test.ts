import { describe, expect, it } from "vitest";
import { createLeverAdapter } from "./lever.ts";

const lever = createLeverAdapter("api.lever.co");

const job = {
  id: "3004bc63-f071-4b93-ae4d-bd2a712e68b4",
  text: "3D Integration Engineer H/F",
  hostedUrl: "https://jobs.lever.co/alice-bob/3004bc63-f071-4b93-ae4d-bd2a712e68b4",
  applyUrl: "https://jobs.lever.co/alice-bob/3004bc63-f071-4b93-ae4d-bd2a712e68b4/apply",
  categories: {
    commitment: "CDI",
    department: "Quantum Hardware",
    location: "Aubervilliers",
    team: "Process Integration",
    allLocations: ["Aubervilliers", "Paris"],
  },
  country: "fr",
  workplaceType: "hybrid",
  createdAt: 1_789_028_197_166,
  description: "<div>Intro</div>",
  lists: [
    { text: "R&D <Requirements>", content: "<li>PhD</li>" },
    { text: "Process", content: "<ul><li>Call</li></ul>" },
  ],
  additional: "<p>Benefits</p>",
  salaryRange: { min: 65_000, max: 82_000, currency: "EUR", interval: "per-year-salary" },
};

describe("lever", () => {
  it("maps a posting and assembles description, lists, and closing text", () => {
    expect(lever.mapJob(job, job.id)).toEqual({
      kind: "posting",
      posting: {
        externalId: job.id,
        title: "3D Integration Engineer H/F",
        url: job.hostedUrl,
        applyUrl: job.applyUrl,
        locations: ["Aubervilliers", "Paris"],
        country: "FR",
        workplace: "hybrid",
        employmentType: "CDI",
        department: "Quantum Hardware",
        team: "Process Integration",
        language: null,
        publishedAt: 1_789_028_197_166,
        salary: { min: 65_000, max: 82_000, currency: "EUR", interval: "year" },
        descriptionHtml:
          "<div>Intro</div><h3>R&amp;D &lt;Requirements&gt;</h3><ul><li>PhD</li></ul>" +
          "<h3>Process</h3><ul><ul><li>Call</li></ul></ul><p>Benefits</p>",
      },
    });
  });

  it("falls back to the primary location when allLocations is missing", () => {
    const result = lever.mapJob({ ...job, categories: { location: "Remote" } }, job.id);
    expect(result.kind === "posting" && result.posting.locations).toEqual(["Remote"]);
  });

  it("maps every declared workplace and leaves unknown ones unset", () => {
    const workplace = (value: unknown) => {
      const result = lever.mapJob({ ...job, workplaceType: value }, job.id);
      return result.kind === "posting" ? result.posting.workplace : "invalid";
    };
    expect(workplace("onsite")).toBe("onsite");
    expect(workplace("on-site")).toBe("onsite");
    expect(workplace("Remote")).toBe("remote");
    expect(workplace("unspecified")).toBeNull();
    expect(workplace(null)).toBeNull();
  });

  it("maps pay intervals and drops ranges it can't interpret", () => {
    const salary = (salaryRange: unknown) => {
      const result = lever.mapJob({ ...job, salaryRange }, job.id);
      return result.kind === "posting" ? result.posting.salary : "invalid";
    };
    expect(salary({ min: 40, max: 55, currency: "USD", interval: "per-hour-wage" })).toEqual({
      min: 40,
      max: 55,
      currency: "USD",
      interval: "hour",
    });
    expect(
      salary({ min: 5_000, max: 6_000, currency: "SGD", interval: "per-month-salary" }),
    ).toEqual({ min: 5_000, max: 6_000, currency: "SGD", interval: "month" });
    expect(salary({ min: 1, max: 2, currency: "USD", interval: "per-fortnight" })).toBeNull();
    expect(salary(null)).toBeNull();
  });

  it("uses the EU host for the EU instance", () => {
    expect(createLeverAdapter("api.eu.lever.co").host).toBe("api.eu.lever.co");
  });

  it("reports schema problems and empty titles as invalid", () => {
    expect(lever.mapJob({ ...job, lists: "none" }, job.id)).toEqual({
      kind: "invalid",
      problem: expect.stringMatching(/^lists: /),
    });
    expect(lever.mapJob({ ...job, text: "" }, job.id)).toEqual({
      kind: "invalid",
      problem: "text: empty",
    });
  });

  it("never resolves API values to properties inherited from Object.prototype", () => {
    for (const odd of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const result = lever.mapJob(
        {
          ...job,
          workplaceType: odd,
          salaryRange: { min: 1, max: 2, currency: "USD", interval: odd },
        },
        job.id,
      );
      expect(result.kind === "posting" && result.posting.workplace).toBeNull();
      expect(result.kind === "posting" && result.posting.salary).toBeNull();
    }
  });

  it("uses the primary location when allLocations is empty", () => {
    const result = lever.mapJob(
      { ...job, categories: { location: "Paris", allLocations: [] } },
      job.id,
    );
    expect(result.kind === "posting" && result.posting.locations).toEqual(["Paris"]);
  });
});
