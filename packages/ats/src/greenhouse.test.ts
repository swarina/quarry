import { describe, expect, it } from "vitest";
import { greenhouse } from "./greenhouse.ts";

const job = {
  id: 7_850_544_003,
  title: "  Administrative   Assistant IV ",
  absolute_url: "https://job-boards.greenhouse.io/affirm/jobs/7850544003",
  content: "&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;R&amp;amp;D team&lt;/p&gt;",
  location: { name: "Remote US" },
  language: "en",
  first_published: "2026-08-19T12:29:00-04:00",
  updated_at: "2026-08-19T16:06:53-04:00",
  departments: [
    { id: 1, name: "Architecture" },
    { id: 2, name: "Other" },
  ],
  offices: [{ id: 3, name: "Remote US" }],
  metadata: null,
};

describe("greenhouse", () => {
  it("reads numeric ids as strings", () => {
    expect(greenhouse.externalId(job)).toBe("7850544003");
    expect(greenhouse.externalId({ id: "42" })).toBe("42");
    expect(() => greenhouse.externalId({ id: "abc" })).toThrow(/^greenhouse: id: /);
    expect(() => greenhouse.externalId({ id: -1 })).toThrow();
  });

  it("maps a job and decodes its escaped content once", () => {
    expect(greenhouse.mapJob(job, "7850544003")).toEqual({
      kind: "posting",
      posting: {
        externalId: "7850544003",
        title: "Administrative Assistant IV",
        url: "https://job-boards.greenhouse.io/affirm/jobs/7850544003",
        applyUrl: null,
        locations: ["Remote US"],
        country: null,
        workplace: null,
        employmentType: null,
        department: "Architecture",
        team: null,
        language: "en",
        publishedAt: Date.UTC(2026, 7, 19, 16, 29),
        salary: null,
        // The escaped entity inside the text stays an entity until text extraction.
        descriptionHtml: "<h2>About</h2><p>R&amp;D team</p>",
      },
    });
  });

  it("tolerates missing optional fields", () => {
    const minimal = {
      id: 1,
      title: "Engineer",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
      content: "",
    };
    const result = greenhouse.mapJob(minimal, "1");
    expect(result.kind).toBe("posting");
    if (result.kind !== "posting") return;
    expect(result.posting.locations).toEqual([]);
    expect(result.posting.department).toBeNull();
    expect(result.posting.language).toBeNull();
    expect(result.posting.publishedAt).toBeNull();
  });

  it("reports schema problems and empty titles as invalid", () => {
    expect(greenhouse.mapJob({ ...job, content: 5 }, "1")).toEqual({
      kind: "invalid",
      problem: expect.stringMatching(/^content: /),
    });
    expect(greenhouse.mapJob({ ...job, title: " " }, "1")).toEqual({
      kind: "invalid",
      problem: "title: empty",
    });
  });
});
