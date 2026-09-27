import { ATS_SOURCES } from "@quarry/domain";
import { describe, expect, it } from "vitest";
import { atsHost, listingRequest, parseListing } from "./adapters.ts";
import { AtsSchemaError } from "./listing.ts";

describe("listingRequest", () => {
  it("builds each source's listing URL with full content", () => {
    expect(listingRequest("greenhouse", "stripe")).toEqual({
      url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true",
      host: "boards-api.greenhouse.io",
    });
    expect(listingRequest("lever", "acme").url).toBe(
      "https://api.lever.co/v0/postings/acme?mode=json",
    );
    expect(listingRequest("lever-eu", "acme").url).toBe(
      "https://api.eu.lever.co/v0/postings/acme?mode=json",
    );
    expect(listingRequest("ashby", "Acme.Inc").url).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/Acme.Inc?includeCompensation=true",
    );
  });

  it("keeps the host consistent with atsHost for every source", () => {
    for (const source of ATS_SOURCES) {
      const request = listingRequest(source, "acme");
      expect(new URL(request.url).host).toBe(request.host);
      expect(atsHost(source)).toBe(request.host);
    }
  });
});

const leverJob = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: `Job ${id}`,
  hostedUrl: `https://jobs.lever.co/acme/${id}`,
  description: "<p>Hello</p>",
  ...extra,
});

describe("parseListing", () => {
  it("rejects bodies that are not listings", () => {
    expect(() => parseListing("greenhouse", { error: "nope" })).toThrow(AtsSchemaError);
    expect(() => parseListing("greenhouse", null)).toThrow(AtsSchemaError);
    expect(() => parseListing("lever", { ok: false })).toThrow(AtsSchemaError);
    expect(() => parseListing("ashby", { jobs: "none" })).toThrow(AtsSchemaError);
  });

  it("rejects a listing with any job whose id is unreadable", () => {
    const error = (() => {
      try {
        parseListing("lever", [leverJob("a"), { text: "No id" }]);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(AtsSchemaError);
    expect((error as AtsSchemaError).source).toBe("lever");
    expect((error as AtsSchemaError).message).toMatch(/^lever: id: /);
  });

  it("names the EU source in its errors", () => {
    expect(() => parseListing("lever-eu", {})).toThrow(/^lever-eu: /);
  });

  it("keeps the first copy of a duplicated job", () => {
    const listing = parseListing("lever", [
      leverJob("a"),
      leverJob("b"),
      leverJob("a", { text: "Dup" }),
    ]);
    expect(listing.items.map((item) => item.externalId)).toEqual(["a", "b"]);
    expect(listing.duplicates).toBe(1);
    const first = listing.items[0];
    expect(first?.kind === "posting" && first.posting.title).toBe("Job a");
  });

  it("reports jobs that don't match the schema as invalid, with their raw data", () => {
    const bad = leverJob("b", { hostedUrl: "not a url" });
    const listing = parseListing("lever", [leverJob("a"), bad]);
    expect(listing.items).toHaveLength(2);
    expect(listing.items[1]).toEqual({
      kind: "invalid",
      externalId: "b",
      problem: expect.stringMatching(/^hostedUrl: /),
      raw: bad,
    });
  });

  it("returns an empty listing for a board with no jobs", () => {
    expect(parseListing("greenhouse", { jobs: [], meta: { total: 0 } })).toEqual({
      items: [],
      duplicates: 0,
      unlisted: 0,
    });
  });

  it("leaves out Ashby jobs that are not publicly listed", () => {
    const listing = parseListing("ashby", {
      jobs: [
        {
          id: "x",
          title: "Hidden",
          jobUrl: "https://jobs.ashbyhq.com/acme/x",
          isListed: false,
          descriptionHtml: "<p>Secret</p>",
        },
      ],
    });
    expect(listing).toEqual({ items: [], duplicates: 0, unlisted: 1 });
  });
});
