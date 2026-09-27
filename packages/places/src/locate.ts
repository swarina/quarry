import type { NormalizedPosting, Workplace } from "@quarry/domain";
import { type LabelReading, type Place, readLabel } from "./read-label.ts";

/** Where a posting is, or who can do it from where, as its labels and structured fields say. */
export interface PostingLocation {
  /** Every place, labels first, without repeats. */
  readonly places: readonly Place[];
  /**
   * Where the places come from: the labels; structured fields (offices, addresses, or a
   * country) when no label names a place ("Hybrid", "Remote"); or nowhere.
   */
  readonly basis: "labels" | "structured" | "none";
  /** The work arrangement the labels state: remote if any says so, then hybrid, then on-site. */
  readonly workplace: Workplace | null;
  /** A label says the job can be done from anywhere. */
  readonly anywhere: boolean;
  /** Labels that named neither a place nor an arrangement, for reports. */
  readonly unplaced: readonly string[];
}

/**
 * Locates a posting from its labels, reading them with its structured places as hints: a
 * stated country or address settles "Georgia" or "London". A label that names no place takes
 * the address the ATS pairs with it; when no label names a place, the structured places stand
 * in. `home` is the company's home country, the weakest hint.
 */
export function locatePosting(
  posting: Pick<NormalizedPosting, "locations" | "places" | "country">,
  home: string | null,
): PostingLocation {
  const stated = posting.places.map((place) => ({
    label: place.label,
    reading: readLabel(place.text, { home }),
  }));
  const hinted = [
    ...(posting.country === null ? [] : [posting.country]),
    ...stated.flatMap(({ reading }) => reading.places.map((place) => place.country)),
  ];
  const hints = { countries: [...new Set(hinted)], home };

  const readings: LabelReading[] = [];
  const places: Place[] = [];
  const unplaced: string[] = [];
  for (const label of posting.locations) {
    const reading = readLabel(label, hints);
    readings.push(reading);
    const paired = stated.find((place) => place.label === label)?.reading.places ?? [];
    const found = reading.places.length > 0 ? reading.places : paired;
    add(places, found);
    if (found.length === 0 && reading.workplace === null && !reading.anywhere) unplaced.push(label);
  }

  let basis: PostingLocation["basis"] = places.length > 0 ? "labels" : "none";
  if (places.length === 0) {
    add(
      places,
      stated.flatMap(({ reading }) => reading.places),
    );
    if (places.length === 0 && posting.country !== null) {
      places.push({ country: posting.country, division: null, city: null });
    }
    if (places.length > 0) basis = "structured";
  }

  const said = (workplace: Workplace) =>
    readings.some((reading) => reading.workplace === workplace);
  return {
    places,
    basis,
    workplace: said("remote")
      ? "remote"
      : said("hybrid")
        ? "hybrid"
        : said("onsite")
          ? "onsite"
          : null,
    anywhere: readings.some((reading) => reading.anywhere),
    unplaced,
  };
}

function add(places: Place[], found: readonly Place[]): void {
  for (const place of found) {
    const known = places.some(
      (other) =>
        other.country === place.country &&
        other.division === place.division &&
        other.city === place.city,
    );
    if (!known) places.push(place);
  }
}
