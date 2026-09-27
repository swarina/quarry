import { describe, expect, it } from "vitest";
import { type NormalizedPosting, postingContent, postingContentHash } from "./posting.ts";

const posting: NormalizedPosting = {
  externalId: "123",
  title: "Backend Engineer",
  url: "https://example.com/jobs/123",
  applyUrl: "https://example.com/jobs/123/apply",
  locations: ["Berlin", "Remote, Germany"],
  country: "DE",
  workplace: "hybrid",
  employmentType: "Full-time",
  department: "Engineering",
  team: "Platform",
  language: "en",
  publishedAt: 1_790_000_000_000,
  salary: { min: 70_000, max: 90_000, currency: "EUR", interval: "year" },
  descriptionHtml: "<h2>Role</h2><p>Build <b>APIs</b>.</p>",
};

describe("postingContent", () => {
  it("keeps the content fields and turns the description into text", () => {
    expect(postingContent(posting)).toEqual({
      title: "Backend Engineer",
      locations: ["Berlin", "Remote, Germany"],
      country: "DE",
      workplace: "hybrid",
      employmentType: "Full-time",
      department: "Engineering",
      team: "Platform",
      salary: { min: 70_000, max: 90_000, currency: "EUR", interval: "year" },
      description: "Role\n\nBuild APIs.",
    });
  });
});

describe("postingContentHash", () => {
  it("ignores links, dates, language, and markup that does not change the text", async () => {
    const hash = await postingContentHash(posting);
    expect(
      await postingContentHash({
        ...posting,
        url: "https://example.com/jobs/123?utm_source=x",
        applyUrl: null,
        publishedAt: null,
        language: null,
        descriptionHtml: '<h2 class="x">Role</h2>\n<p>Build <strong>APIs</strong>.</p>',
      }),
    ).toBe(hash);
  });

  it("changes when the text, title, locations, or salary change", async () => {
    const hash = await postingContentHash(posting);
    const edits: Partial<NormalizedPosting>[] = [
      { title: "Senior Backend Engineer" },
      { locations: ["Berlin"] },
      { locations: ["Remote, Germany", "Berlin"] },
      { workplace: "remote" },
      { salary: { min: 75_000, max: 90_000, currency: "EUR", interval: "year" } },
      { descriptionHtml: "<h2>Role</h2><p>Build APIs and SDKs.</p>" },
    ];
    for (const edit of edits) {
      expect(await postingContentHash({ ...posting, ...edit })).not.toBe(hash);
    }
  });
});
