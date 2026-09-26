import { decodeHTML } from "entities/decode";
import { z } from "zod";
import { cleanList, cleanText, httpUrl, parseTimestamp } from "./fields.ts";
import { type AtsAdapter, AtsSchemaError, describeIssues } from "./listing.ts";

const listing = z.looseObject({ jobs: z.array(z.unknown()) });
const jobId = z.looseObject({
  id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
});

const job = z.looseObject({
  title: z.string(),
  absolute_url: httpUrl,
  // Greenhouse HTML-escapes the markup, so the HTML has to be decoded once before use.
  content: z.string(),
  location: z.looseObject({ name: z.string().nullish() }).nullish(),
  language: z.string().nullish(),
  first_published: z.string().nullish(),
  departments: z.array(z.looseObject({ name: z.string() })).nullish(),
});

/**
 * Greenhouse Job Board API: `GET /v1/boards/{board}/jobs?content=true` on
 * `boards-api.greenhouse.io` lists every published job with its content. The listing has no
 * structured workplace, employment type, or pay fields.
 */
export const greenhouse: AtsAdapter = {
  host: "boards-api.greenhouse.io",

  listingPath: (slug) => `/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,

  jobs(body) {
    const parsed = listing.safeParse(body);
    if (!parsed.success) throw new AtsSchemaError("greenhouse", describeIssues(parsed.error));
    return parsed.data.jobs;
  },

  externalId(value) {
    const parsed = jobId.safeParse(value);
    if (!parsed.success) throw new AtsSchemaError("greenhouse", describeIssues(parsed.error));
    return String(parsed.data.id);
  },

  mapJob(value, externalId) {
    const parsed = job.safeParse(value);
    if (!parsed.success) return { kind: "invalid", problem: describeIssues(parsed.error) };
    const data = parsed.data;
    const title = cleanText(data.title);
    if (title === null) return { kind: "invalid", problem: "title: empty" };
    return {
      kind: "posting",
      posting: {
        externalId,
        title,
        url: data.absolute_url,
        applyUrl: null,
        locations: cleanList([data.location?.name]),
        country: null,
        workplace: null,
        employmentType: null,
        department: cleanText(data.departments?.[0]?.name),
        team: null,
        language: cleanText(data.language),
        publishedAt: parseTimestamp(data.first_published),
        salary: null,
        descriptionHtml: decodeHTML(data.content),
      },
    };
  },
};
