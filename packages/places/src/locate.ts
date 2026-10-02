import type { NormalizedPosting, Workplace } from "@quarry/domain";
import { type LabelReading, type Place, readLabel } from "./read-label.ts";
import { foldName } from "./text.ts";

/** Where a posting is, or who can do it from where, as its labels and structured fields say. */
export interface PostingLocation {
  /** Every place, labels first, without repeats. */
  readonly places: readonly Place[];
  /**
   * Where the places come from: the labels; structured fields (offices, addresses, or a
   * country) when no label names a place ("Hybrid", "Remote"); the company's home country,
   * inferred, when nothing names a place but the job is hybrid, on-site, or at headquarters;
   * or nowhere.
   */
  readonly basis: "labels" | "structured" | "home" | "none";
  /** The work arrangement the labels state: remote if any says so, then hybrid, then on-site. */
  readonly workplace: Workplace | null;
  /** A label says the job can be done from anywhere. */
  readonly anywhere: boolean;
  /** Labels that named neither a place nor an arrangement, for reports. */
  readonly unplaced: readonly string[];
}

/**
 * The places of the structured offices that say the label again with more around it, for a
 * label that named no place of its own. A board that writes "Karkiv" and lists an office
 * "Karkiv, Ukraine" has told us the country, even though the city is misspelt; without this,
 * such a posting falls back to every office the company has, which is a much worse answer.
 *
 * The label must be a whole word in the office's text and long enough not to match by accident.
 */
interface Stated {
  readonly label: string | null;
  readonly text: string;
  readonly reading: LabelReading;
}

const SHORTEST_NAMESAKE = 4;

/** The words of a folded text, so a label matches a whole word rather than part of one. */
function words(text: string): string {
  return ` ${foldName(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

function namesake(stated: readonly Stated[], label: string): Place[] | undefined {
  const folded = foldName(label);
  if (folded.length < SHORTEST_NAMESAKE) return undefined;
  const wanted = words(label).trimEnd();
  const found = stated.filter(
    (place) => place.label === null && words(place.text).includes(wanted),
  );
  return found.length === 0 ? undefined : found.flatMap((place) => place.reading.places);
}

/** A label that means the company's headquarters and names nothing else ("HQ", "Head Office"). */
const HEADQUARTERS =
  /^\W*(?:(?:company|corporate|global|main)\s+)?(?:headquarters|hq|head\s*office)\W*$/i;
/** Remote, as labels spell it; a label like "Hybrid or Remote" reads as hybrid alone. */
const REMOTE = /\bremot[aeo]\b/i;

/**
 * Locates a posting from its labels, reading them with its structured places as hints: a
 * stated country or address settles "Georgia" or "London". A label that names no place takes
 * the address the ATS pairs with it; when no label names a place, the structured places stand
 * in. `home` is the company's home country: the weakest hint, and the place of last resort for
 * a hybrid, on-site, or headquarters job that nothing else places.
 */
export function locatePosting(
  posting: Pick<NormalizedPosting, "locations" | "places" | "country" | "workplace">,
  home: string | null,
): PostingLocation {
  const stated: Stated[] = posting.places.map((place) => ({
    label: place.label,
    text: place.text,
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
    // A label the reader understood as an arrangement ("Remote") is not a place name, so it
    // must not match an office by its words; only unreadable text looks for its namesake.
    const unreadable = reading.workplace === null && !reading.anywhere;
    const paired =
      stated.find((place) => place.label === label)?.reading.places ??
      (unreadable ? namesake(stated, label) : undefined) ??
      [];
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
  const workplace = said("remote")
    ? "remote"
    : said("hybrid")
      ? "hybrid"
      : said("onsite")
        ? "onsite"
        : null;
  const anywhere = readings.some((reading) => reading.anywhere);
  if (
    places.length === 0 &&
    home !== null &&
    !anywhere &&
    atHome(posting, readings, stated, workplace)
  ) {
    places.push({ country: home, division: null, city: null });
    basis = "home";
  }
  return { places, basis, workplace, anywhere, unplaced };
}

/**
 * Whether a posting nothing places can be put in its company's home country. Someone doing a
 * hybrid or on-site job, or one at headquarters, works at an office, and a company that names
 * no other place most likely means one at home. So every label and structured field must say
 * only that: none may say remote (remote jobs can be anywhere), name nothing we can use
 * ("Multiple locations"), or hold text we can't read, since the place may be in it.
 */
function atHome(
  posting: Pick<NormalizedPosting, "locations" | "places" | "workplace">,
  labels: readonly LabelReading[],
  stated: readonly Stated[],
  workplace: Workplace | null,
): boolean {
  const arrangement = posting.workplace ?? workplace;
  if (arrangement === "remote") return false;
  const texts = [
    ...posting.locations.map((text, index) => ({ text, reading: labels[index] })),
    ...posting.places.map((place, index) => ({
      text: place.text,
      reading: stated[index]?.reading,
    })),
  ];
  let headquarters = false;
  for (const { text, reading } of texts) {
    if (REMOTE.test(text)) return false;
    if (HEADQUARTERS.test(text)) headquarters = true;
    else if (reading === undefined || reading.workplace === null || reading.unmatched.length > 0) {
      return false;
    }
  }
  return headquarters || arrangement === "hybrid" || arrangement === "onsite";
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
