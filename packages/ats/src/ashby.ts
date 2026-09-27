import type { PayInterval, StatedPlace, Workplace } from "@quarry/domain";
import { z } from "zod";
import { cleanList, cleanText, httpUrl, parseTimestamp, placeText, salaryRange } from "./fields.ts";
import { type AtsAdapter, AtsSchemaError, describeIssues } from "./listing.ts";

const listing = z.looseObject({ jobs: z.array(z.unknown()) });
const jobId = z.looseObject({ id: z.string().min(1).max(200) });

const compensationComponent = z.looseObject({
  compensationType: z.string(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

// Hints only: a change in their shape must never make the posting unreadable.
const address = z
  .looseObject({
    postalAddress: z
      .looseObject({
        addressLocality: z.string().nullish(),
        addressRegion: z.string().nullish(),
        addressCountry: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish()
  .catch(null);

const locationEntry = z.looseObject({ location: z.string().nullish(), address });

const job = z.looseObject({
  title: z.string(),
  jobUrl: httpUrl,
  applyUrl: httpUrl.nullish(),
  isListed: z.boolean().nullish(),
  location: z.string().nullish(),
  address,
  secondaryLocations: z.array(z.looseObject({ location: z.string().nullish(), address })).nullish(),
  workplaceType: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  employmentType: z.string().nullish(),
  department: z.string().nullish(),
  team: z.string().nullish(),
  publishedAt: z.string().nullish(),
  descriptionHtml: z.string(),
  compensation: z
    .looseObject({ summaryComponents: z.array(compensationComponent).nullish() })
    .nullish(),
});

// Maps, not object literals: a lookup must never reach Object.prototype, whatever string the
// API sends (for example "constructor").
const WORKPLACES: ReadonlyMap<string, Workplace> = new Map([
  ["onsite", "onsite"],
  ["hybrid", "hybrid"],
  ["remote", "remote"],
]);

const PAY_INTERVALS: ReadonlyMap<string, PayInterval> = new Map([
  ["1 YEAR", "year"],
  ["1 MONTH", "month"],
  ["1 WEEK", "week"],
  ["1 DAY", "day"],
  ["1 HOUR", "hour"],
]);

/**
 * Ashby public job posting API: `GET /posting-api/job-board/{board}?includeCompensation=true`
 * on `api.ashbyhq.com`. Jobs with `isListed: false` are meant to be reachable only by direct
 * link, so they are left out.
 */
export const ashby: AtsAdapter = {
  host: "api.ashbyhq.com",

  listingPath: (slug) =>
    `/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,

  jobs(body) {
    const parsed = listing.safeParse(body);
    if (!parsed.success) throw new AtsSchemaError("ashby", describeIssues(parsed.error));
    return parsed.data.jobs;
  },

  externalId(value) {
    const parsed = jobId.safeParse(value);
    if (!parsed.success) throw new AtsSchemaError("ashby", describeIssues(parsed.error));
    return parsed.data.id;
  },

  mapJob(value, externalId) {
    const parsed = job.safeParse(value);
    if (!parsed.success) return { kind: "invalid", problem: describeIssues(parsed.error) };
    const data = parsed.data;
    if (data.isListed === false) return { kind: "unlisted" };
    const title = cleanText(data.title);
    if (title === null) return { kind: "invalid", problem: "title: empty" };
    const declared = data.workplaceType?.replace(/[^a-z]/gi, "").toLowerCase() ?? "";
    const pay = data.compensation?.summaryComponents?.find(
      (component) => component.compensationType === "Salary",
    );
    return {
      kind: "posting",
      posting: {
        externalId,
        title,
        url: data.jobUrl,
        applyUrl: data.applyUrl ?? null,
        locations: cleanList([
          data.location,
          ...(data.secondaryLocations ?? []).map((entry) => entry.location),
        ]),
        places: addressPlaces([
          { location: data.location, address: data.address },
          ...(data.secondaryLocations ?? []),
        ]),
        country: null,
        workplace: WORKPLACES.get(declared) ?? (data.isRemote === true ? "remote" : null),
        employmentType: cleanText(data.employmentType),
        department: cleanText(data.department),
        team: cleanText(data.team),
        language: null,
        publishedAt: parseTimestamp(data.publishedAt),
        salary: salaryRange(
          pay?.minValue,
          pay?.maxValue,
          pay?.currencyCode,
          PAY_INTERVALS.get(pay?.interval ?? ""),
        ),
        descriptionHtml: data.descriptionHtml,
      },
    };
  },
};

/**
 * Each location's postal address (locality, region, country), paired with its label. Ashby
 * fills the address from a place picker, so it names the country even when the label is
 * "NAMER" or "Remote".
 */
function addressPlaces(locations: readonly z.infer<typeof locationEntry>[]): StatedPlace[] {
  const places: StatedPlace[] = [];
  for (const { location, address: stated } of locations) {
    const postal = stated?.postalAddress;
    const text = placeText([
      postal?.addressLocality,
      postal?.addressRegion,
      postal?.addressCountry,
    ]);
    const label = cleanText(location);
    if (text !== null && !places.some((place) => place.label === label && place.text === text)) {
      places.push({ label, text });
    }
  }
  return places;
}
