export { atsHost, listingRequest, parseListing } from "./adapters.ts";
export type { ListedItem, ListingRequest, ParsedListing } from "./listing.ts";
export { AtsSchemaError } from "./listing.ts";

/**
 * Version of the mapping from ATS responses to `NormalizedPosting`, including everything that
 * feeds `postingContentHash` (such as `htmlToText` in `@quarry/domain`). Bump it whenever that
 * output can change for the same response, so a new content hash caused by our code is not
 * mistaken for an employer's edit.
 */
export const NORMALIZER_VERSION = 1;
