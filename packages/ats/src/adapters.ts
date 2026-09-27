import type { AtsSource } from "@quarry/domain";
import { ashby } from "./ashby.ts";
import { greenhouse } from "./greenhouse.ts";
import { createLeverAdapter } from "./lever.ts";
import type { AtsAdapter, ListedItem, ListingRequest, ParsedListing } from "./listing.ts";

const ADAPTERS: Readonly<Record<AtsSource, AtsAdapter>> = {
  greenhouse,
  lever: createLeverAdapter("api.lever.co"),
  "lever-eu": createLeverAdapter("api.eu.lever.co"),
  ashby,
};

/** The listing endpoint for a board, with full job content in one response. */
export function listingRequest(source: AtsSource, slug: string): ListingRequest {
  const adapter = ADAPTERS[source];
  return { url: `https://${adapter.host}${adapter.listingPath(slug)}`, host: adapter.host };
}

/** The API host of a source, which is what politeness limits are keyed on. */
export function atsHost(source: AtsSource): string {
  return ADAPTERS[source].host;
}

/**
 * Parses a listing response body (already decoded from JSON). Throws `AtsSchemaError` when the
 * body is not a listing or any job lacks a readable id; otherwise every job is returned, with
 * jobs that don't match the schema reported as invalid rather than dropped.
 */
export function parseListing(source: AtsSource, body: unknown): ParsedListing {
  const adapter = ADAPTERS[source];
  const items: ListedItem[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let unlisted = 0;
  for (const raw of adapter.jobs(body)) {
    const externalId = adapter.externalId(raw);
    if (seen.has(externalId)) {
      duplicates += 1;
      continue;
    }
    seen.add(externalId);
    const result = adapter.mapJob(raw, externalId);
    switch (result.kind) {
      case "posting":
        items.push({ kind: "posting", externalId, posting: result.posting, raw });
        break;
      case "invalid":
        items.push({ kind: "invalid", externalId, problem: result.problem, raw });
        break;
      case "unlisted":
        unlisted += 1;
        break;
    }
  }
  return { items, duplicates, unlisted };
}
