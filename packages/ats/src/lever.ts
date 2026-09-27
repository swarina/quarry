import type { PayInterval, Workplace } from "@quarry/domain";
import { z } from "zod";
import { cleanList, cleanText, countryCode, escapeHtml, httpUrl, salaryRange } from "./fields.ts";
import { type AtsAdapter, AtsSchemaError, describeIssues } from "./listing.ts";

const listing = z.array(z.unknown());
const jobId = z.looseObject({ id: z.string().min(1).max(200) });

const job = z.looseObject({
  text: z.string(),
  hostedUrl: httpUrl,
  applyUrl: httpUrl.nullish(),
  categories: z
    .looseObject({
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
      commitment: z.string().nullish(),
      department: z.string().nullish(),
      team: z.string().nullish(),
    })
    .nullish(),
  country: z.string().nullish(),
  workplaceType: z.string().nullish(),
  createdAt: z.number().nullish(),
  description: z.string().nullish(),
  lists: z.array(z.looseObject({ text: z.string(), content: z.string() })).nullish(),
  additional: z.string().nullish(),
  salaryRange: z
    .looseObject({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
});

// Maps, not object literals: a lookup must never reach Object.prototype, whatever string the
// API sends (for example "constructor").
const WORKPLACES: ReadonlyMap<string, Workplace> = new Map([
  ["onsite", "onsite"],
  ["on-site", "onsite"],
  ["hybrid", "hybrid"],
  ["remote", "remote"],
]);

const PAY_INTERVALS: ReadonlyMap<string, PayInterval> = new Map([
  ["per-year-salary", "year"],
  ["per-month-salary", "month"],
  ["per-week-salary", "week"],
  ["per-day-wage", "day"],
  ["per-hour-wage", "hour"],
]);

/**
 * Lever Postings API: `GET /v0/postings/{site}?mode=json` lists every published posting with
 * its content. Lever's EU instance serves the same API from its own host.
 */
export function createLeverAdapter(host: "api.lever.co" | "api.eu.lever.co"): AtsAdapter {
  const source = host === "api.lever.co" ? "lever" : "lever-eu";
  return {
    host,

    listingPath: (slug) => `/v0/postings/${encodeURIComponent(slug)}?mode=json`,

    jobs(body) {
      const parsed = listing.safeParse(body);
      if (!parsed.success) throw new AtsSchemaError(source, describeIssues(parsed.error));
      return parsed.data;
    },

    externalId(value) {
      const parsed = jobId.safeParse(value);
      if (!parsed.success) throw new AtsSchemaError(source, describeIssues(parsed.error));
      return parsed.data.id;
    },

    mapJob(value, externalId) {
      const parsed = job.safeParse(value);
      if (!parsed.success) return { kind: "invalid", problem: describeIssues(parsed.error) };
      const data = parsed.data;
      const title = cleanText(data.text);
      if (title === null) return { kind: "invalid", problem: "text: empty" };
      const categories = data.categories;
      const salary = data.salaryRange;
      return {
        kind: "posting",
        posting: {
          externalId,
          title,
          url: data.hostedUrl,
          applyUrl: data.applyUrl ?? null,
          locations: cleanList(
            categories?.allLocations?.length ? categories.allLocations : [categories?.location],
          ),
          country: countryCode(data.country),
          workplace: WORKPLACES.get(data.workplaceType?.trim().toLowerCase() ?? "") ?? null,
          employmentType: cleanText(categories?.commitment),
          department: cleanText(categories?.department),
          team: cleanText(categories?.team),
          language: null,
          // Lever exposes only when the posting was created, which is the closest it has.
          publishedAt: typeof data.createdAt === "number" ? data.createdAt : null,
          salary: salaryRange(
            salary?.min,
            salary?.max,
            salary?.currency,
            PAY_INTERVALS.get(salary?.interval ?? ""),
          ),
          descriptionHtml: [
            data.description ?? "",
            ...(data.lists ?? []).map(
              (list) => `<h3>${escapeHtml(list.text)}</h3><ul>${list.content}</ul>`,
            ),
            data.additional ?? "",
          ].join(""),
        },
      };
    },
  };
}
