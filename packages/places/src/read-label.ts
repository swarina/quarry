import type { Workplace } from "@quarry/domain";
import { type NameMatch, nameIndex } from "./names.ts";
import { foldName } from "./text.ts";

/** A place a label names, as specific as the label is. */
export interface Place {
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  /** The first-level division's GeoNames code within the country, when known. */
  readonly division: string | null;
  /** The city's GeoNames id, when known. */
  readonly city: number | null;
}

export interface LabelReading {
  /** Every place the label names, in the order it names them. */
  readonly places: readonly Place[];
  /** The work arrangement the label states ("Remote - US", "Hybrid"), if any. */
  readonly workplace: Workplace | null;
  /** The label says the job can be done from anywhere ("Worldwide"). */
  readonly anywhere: boolean;
  /** Parts of the label that named no place, for reports. */
  readonly unmatched: readonly string[];
}

export interface ReadingHints {
  /** Countries the posting is known to involve, from structured fields. They settle close calls. */
  readonly countries?: readonly string[];
  /** The company's home country: the weakest hint. */
  readonly home?: string | null;
}

// Scores. A reading's score is its own weight, plus context from the rest of the label and
// the hints, plus how well it fits the tokens next to it ("San Francisco, CA").
const COUNTRY_NAME = 10;
const COUNTRY_CODE = 8;
const REGION = 10;
const DIVISION_NAME = 7;
const DIVISION_CODE = 6;
const CITY = 5;
const NAMED_ELSEWHERE = 6;
const IMPLIED_ELSEWHERE = 3;
const HINTED = 4;
const HOME = 1;
const CITY_IN_DIVISION = 6;
const IN_COUNTRY = 4;
const MISMATCH = -1;
/** A country code next to a city elsewhere is a division code ("Bergamo, BG, Italy"). */
const CODE_MISMATCH = -9;
/** A city this big wins over the division it shares its name with ("New York", "Wellington"). */
const NAMESAKE_CITY_POPULATION = 200_000;
const NAMESAKE_CITY = 3;
/** Candidates kept per token; the rest can't win. */
const CANDIDATES = 6;

/** A whole phrase from a list, as a pattern. */
function phrases(list: readonly string[]): RegExp {
  return new RegExp(`^(?:${list.join("|")})$`);
}

const REMOTE = phrases([
  "(?:(?:fully|100%|full) )?remote(?: first| only| friendly| ok)?(?: (?:in|within|from|across)(?: the)?)?",
  "work(?:ing)? from home",
  "wfh",
  "home ?based",
  "home office",
  "telecommut\\w*",
  "telework\\w*",
  "virtual",
  "distributed",
  // Spanish, Portuguese, Italian, French.
  "remot[oa]",
  "teletrabajo",
  "teletrabalho",
  "teletravail",
]);
const HYBRID = phrases(["hybrid(?: remote)?", "remote hybrid", "hibrido", "ibrido", "hybride"]);
const ONSITE = phrases(["on ?site", "in office", "in person", "office based", "presencial"]);
const ANYWHERE = phrases([
  "anywhere",
  "worldwide",
  "world ?wide",
  "global(?:ly)?",
  "international",
  "everywhere",
  "any location",
  "all locations",
  "all countries",
]);
const NOISE = phrases([
  "hq",
  "headquarters",
  "(?:head|main) office",
  "offices?",
  "campus",
  "hub",
  "only",
  "preferred",
  "based",
  "(?:metro |metropolitan )?area",
  "region",
  "time ?zones?",
  "tbd",
  "various",
  "multiple locations",
  "locations?",
  "travel required",
  "all",
  "and",
  "or",
  "in",
  "the",
]);
/** Words that end a street address or begin a floor ("260 Burwood Rd", "Level 2"). */
const STREET =
  /^(?:.+ (?:st|rd|ave|street|road|avenue|blvd|boulevard|sq|square)|(?:level|floor|suite|unit) .*)$/;
/** A label names foreign places this small only by accident ("Kent" next to "London"). */
const FOREIGN_POPULATION = 1_000_000;
const FOREIGN = -8;
/** Flag emoji are pairs of regional indicator letters: the flag of France is F, R. */
const REGIONAL_A = 0x1f1e6;
const FLAG = new RegExp(
  `[${String.fromCodePoint(REGIONAL_A)}-${String.fromCodePoint(REGIONAL_A + 25)}]{2}`,
  "gu",
);
/** Time zone abbreviations, which look like country codes ("PT" is not Portugal here). */
const TIME_ZONES: ReadonlySet<string> = new Set(
  ["PT", "ET", "CT", "PST", "EST", "CST", "MST", "PDT", "EDT", "CDT", "MDT", "GMT", "UTC"].concat([
    "CET",
    "CEST",
    "EET",
    "EEST",
    "WET",
    "BST",
    "AEST",
    "AEDT",
    "JST",
    "SGT",
    "HKT",
  ]),
);

interface Token {
  readonly text: string;
  /** Tokens in one segment can qualify each other ("City, ST"); segments are listed apart. */
  readonly segment: number;
  readonly candidates: readonly { readonly match: NameMatch; readonly weight: number }[];
}

interface Flags {
  workplace: Workplace | null;
  anywhere: boolean;
}

const cache = new Map<string, LabelReading>();
const CACHE_LIMIT = 50_000;

/**
 * Reads a location label ("San Francisco, CA | Remote - US", "Hybrid", "London, UK") into
 * places, a work arrangement, and whether it allows anywhere. Names are matched against the
 * GeoNames gazetteer; ambiguous ones ("CA", "Georgia", "London") are settled by the rest of
 * the label, then by the hints, then by population.
 */
export function readLabel(label: string, hints: ReadingHints = {}): LabelReading {
  const key = `${label}\n${(hints.countries ?? []).join(",")}\n${hints.home ?? ""}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const reading = read(label, hints);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, reading);
  return reading;
}

function read(label: string, hints: ReadingHints): LabelReading {
  const flags: Flags = { workplace: null, anywhere: false };
  const unmatched: string[] = [];
  const tokens: Token[] = [];
  segments(label).forEach((segment, index) => {
    for (const chunk of chunks(segment)) {
      for (const text of tokenTexts(chunk, flags)) {
        const candidates = candidatesFor(text);
        if (candidates.length === 0) unmatched.push(text);
        else tokens.push({ text, segment: index, candidates });
      }
    }
  });
  const chosen = choose(tokens, hints);
  tokens.forEach((token, index) => {
    if (chosen[index] === undefined) unmatched.push(token.text);
  });
  return {
    places: assemble(chosen),
    workplace: flags.workplace,
    anywhere: flags.anywhere,
    unmatched,
  };
}

/** Parts of a label that name places independently: "SF, CA | NYC, NY; Remote". */
function segments(label: string): string[] {
  return label
    .normalize("NFKC")
    .replace(FLAG, (flag) =>
      String.fromCharCode(
        ...Array.from(flag, (letter) => (letter.codePointAt(0) ?? 0) - REGIONAL_A + 65),
      ),
    )
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\bn\/a\b/gi, " ")
    .split(/[|;/\n\u2022\u00b7]|\s[\u2013\u2014]\s/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** A segment's comma, colon, dash, and bracket separated pieces: "Canada - Remote (ON, BC)". */
function chunks(segment: string): string[] {
  return segment
    .split(/[,:()[\]]|\s-\s/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * The place names in a chunk, once work arrangements, noise words, and numbers are taken out
 * ("CAN: British Columbia Remote" gives "British Columbia"). A chunk that isn't a name as a
 * whole is split on "and", "&", and "or", and a trailing code or country is split off
 * ("Austin TX").
 */
function tokenTexts(chunk: string, flags: Flags): string[] {
  if (TIME_ZONES.has(chunk)) return [];
  if (candidatesFor(chunk).length > 0) return [chunk];
  const words = chunk
    .split(/\s+/)
    .filter((word) => !/\d/.test(word))
    .join(" ");
  const stripped = stripArrangements(words, flags);
  if (stripped.length === 0 || STREET.test(foldName(stripped))) return [];
  if (candidatesFor(stripped).length > 0) return [stripped];
  const alternatives = stripped.split(/\s+(?:and|&|or|\+)\s+|\s*&\s*/i);
  if (alternatives.length > 1) return alternatives.flatMap((part) => tokenTexts(part, flags));
  return splitNames(stripped);
}

/**
 * Splits text that isn't a name as a whole at the space that leaves the most of it named:
 * "Austin TX" into both parts, "Strava SF" into an unmatched "Strava" and "SF". Text ending
 * in "City" is also tried without it ("Hsinchu City").
 */
function splitNames(text: string): string[] {
  const words = text.split(" ");
  if (words.length > 1 && words.at(-1)?.toLowerCase() === "city") {
    const shorter = words.slice(0, -1).join(" ");
    if (candidatesFor(shorter).length > 0) return [shorter];
  }
  if (words.length < 2 || words.length > 6) return [text];
  let best: { parts: string[]; named: number } = { parts: [text], named: 0 };
  for (let at = 1; at < words.length; at += 1) {
    const parts = [words.slice(0, at).join(" "), words.slice(at).join(" ")];
    const named = parts
      .filter((part) => candidatesFor(part).length > 0)
      .reduce((total, part) => total + part.length, 0);
    if (named > best.named) best = { parts, named };
  }
  return best.parts;
}

/** Removes work arrangement and noise phrases from both ends, noting what they said. */
function stripArrangements(text: string, flags: Flags): string {
  const words = text.split(/[\s-]+/).filter((word) => word.length > 0);
  const phrase = (from: number, to: number) => foldName(words.slice(from, to).join(" "));
  const classify = (folded: string): boolean => {
    if (REMOTE.test(folded)) flags.workplace ??= "remote";
    else if (HYBRID.test(folded)) flags.workplace = "hybrid";
    else if (ONSITE.test(folded)) flags.workplace ??= "onsite";
    else if (ANYWHERE.test(folded)) flags.anywhere = true;
    else return NOISE.test(folded);
    return true;
  };
  let start = 0;
  let end = words.length;
  let changed = true;
  while (changed && start < end) {
    changed = false;
    // Longest phrase first, so "remote in the" goes before "remote".
    for (let length = Math.min(4, end - start); length >= 1 && !changed; length -= 1) {
      if (classify(phrase(start, start + length))) {
        start += length;
        changed = true;
      } else if (end - length > start && classify(phrase(end - length, end))) {
        end -= length;
        changed = true;
      }
    }
  }
  return words.slice(start, end).join(" ");
}

function candidatesFor(text: string): readonly { match: NameMatch; weight: number }[] {
  const index = nameIndex();
  const code = /^(?:[A-Z]\.?){2,4}$/.test(text) ? text.replaceAll(".", "") : "";
  // A short word in capitals is a code or an acronym ("UK", "EMEA"), never a city or division
  // name that happens to match ("CHI" is not a town in Hebei).
  const matches: NameMatch[] = index
    .byName(foldName(text))
    .filter((match) => code.length === 0 || match.kind === "country" || match.kind === "region");
  if (code.length > 0 && !TIME_ZONES.has(code)) matches.push(...index.byCode(code));
  const folded = foldName(text);
  return matches
    .map((match) => ({ match, weight: weightOf(match, folded) }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, CANDIDATES);
}

function weightOf(match: NameMatch, folded: string): number {
  switch (match.kind) {
    case "country":
      return match.by === "name" ? COUNTRY_NAME : COUNTRY_CODE;
    case "region":
      return REGION;
    case "division":
      return match.by === "name" ? DIVISION_NAME : DIVISION_CODE;
    case "city": {
      const { city } = match;
      const size = Math.min(3.5, Math.max(0, Math.log10(Math.max(1, city.population)) - 4));
      const namesake =
        city.population >= NAMESAKE_CITY_POPULATION &&
        nameIndex()
          .byName(folded)
          .some(
            (other) =>
              other.kind === "division" &&
              other.country === city.country &&
              other.division === city.division,
          );
      return CITY + size + (namesake ? NAMESAKE_CITY : 0);
    }
  }
}

function countryOf(match: NameMatch): readonly string[] {
  switch (match.kind) {
    case "country":
    case "division":
      return [match.country];
    case "region":
      return match.region.countries;
    case "city":
      return [match.city.country];
  }
}

/**
 * The best reading of every token (undefined for none), maximizing the sum of each reading's
 * weight, its context, and how it fits the previous token of the same segment. Only
 * neighbors interact, so this is a Viterbi pass over the tokens.
 */
function choose(tokens: readonly Token[], hints: ReadingHints): (NameMatch | undefined)[] {
  // Countries each token names outright ("Germany", "EMEA", "USA"; not "CA", which may be
  // California), and those it implies by naming a city or division, for the others' context.
  const named = tokens.map((token) => {
    const best = token.candidates[0]?.match;
    const outright =
      best !== undefined &&
      (best.kind === "region" ||
        (best.kind === "country" &&
          (best.by === "name" || !token.candidates.some((c) => c.match.kind === "division"))));
    return best !== undefined && outright ? new Set(countryOf(best)) : new Set<string>();
  });
  const implied = tokens.map((token) => {
    const best = token.candidates[0]?.match;
    return best !== undefined && (best.kind === "city" || best.kind === "division")
      ? new Set(countryOf(best))
      : new Set<string>();
  });
  const hinted = new Set(hints.countries ?? []);
  const scores = tokens.map((token, index) =>
    token.candidates.map(({ match, weight }) => {
      const countries = countryOf(match);
      const others = (sets: readonly Set<string>[]) =>
        sets.some((set, other) => other !== index && countries.some((country) => set.has(country)));
      const namedElsewhere = others(named);
      const namedByOthers = named.some((set, other) => other !== index && set.size > 0);
      const small =
        (match.kind === "city" && match.city.population < FOREIGN_POPULATION) ||
        match.kind === "division";
      const foreign = namedByOthers && !namedElsewhere && small;
      return (
        weight +
        (namedElsewhere ? NAMED_ELSEWHERE : others(implied) ? IMPLIED_ELSEWHERE : 0) +
        (foreign ? FOREIGN : 0) +
        (countries.some((country) => hinted.has(country)) ? HINTED : 0) +
        (countries.includes(hints.home ?? "") ? HOME : 0)
      );
    }),
  );

  // States per token: each candidate, then "none".
  let previous: { score: number; path: (NameMatch | undefined)[] }[] = [{ score: 0, path: [] }];
  tokens.forEach((token, index) => {
    const options: (NameMatch | undefined)[] = [...token.candidates.map((c) => c.match), undefined];
    previous = options.map((option, optionIndex) => {
      const own = option === undefined ? 0 : (scores[index]?.[optionIndex] ?? 0);
      let best = { score: Number.NEGATIVE_INFINITY, path: [] as (NameMatch | undefined)[] };
      for (const state of previous) {
        const before = state.path.at(-1);
        const sameSegment = tokens[index - 1]?.segment === token.segment;
        const fit = sameSegment ? fitOf(before, option) : 0;
        if (state.score + own + fit > best.score) {
          best = { score: state.score + own + fit, path: [...state.path, option] };
        }
      }
      return best;
    });
  });
  return previous.reduce((best, state) => (state.score > best.score ? state : best)).path;
}

/** How well two neighboring readings fit: a city and its division or country, and so on. */
function fitOf(left: NameMatch | undefined, right: NameMatch | undefined): number {
  if (left === undefined || right === undefined) return 0;
  const [city, other] = left.kind === "city" ? [left, right] : [right, left];
  if (city.kind === "city") {
    if (other.kind === "division") {
      return other.country === city.city.country && other.division === city.city.division
        ? CITY_IN_DIVISION
        : MISMATCH;
    }
    if (other.kind !== "country") return 0;
    if (other.country === city.city.country) return IN_COUNTRY;
    return other.by === "code" ? CODE_MISMATCH : MISMATCH;
  }
  if (left.kind === "division" && right.kind === "country") {
    return left.country === right.country ? IN_COUNTRY : MISMATCH;
  }
  if (left.kind === "country" && right.kind === "division") {
    return left.country === right.country ? IN_COUNTRY : MISMATCH;
  }
  return 0;
}

/**
 * Places from the chosen readings: a city is one place; a division or country is one only
 * when no city (or division) of the label already lies in it; a region is all its countries.
 */
function assemble(chosen: readonly (NameMatch | undefined)[]): Place[] {
  const places: Place[] = [];
  const has = (place: Place) =>
    places.some(
      (known) =>
        known.country === place.country &&
        known.division === place.division &&
        known.city === place.city,
    );
  const matches = chosen.filter((match): match is NameMatch => match !== undefined);
  const covered = (country: string, division: string | null) =>
    matches.some((match) =>
      division === null
        ? (match.kind === "city" && match.city.country === country) ||
          (match.kind === "division" && match.country === country)
        : match.kind === "city" &&
          match.city.country === country &&
          match.city.division === division,
    );
  for (const match of matches) {
    let found: Place[] = [];
    switch (match.kind) {
      case "city":
        found = [
          {
            country: match.city.country,
            division: match.city.division === "" ? null : match.city.division,
            city: match.city.id,
          },
        ];
        break;
      case "division":
        if (!covered(match.country, match.division)) {
          found = [{ country: match.country, division: match.division, city: null }];
        }
        break;
      case "country":
        if (!covered(match.country, null))
          found = [{ country: match.country, division: null, city: null }];
        break;
      case "region":
        found = match.region.countries.map((country) => ({ country, division: null, city: null }));
        break;
    }
    for (const place of found) if (!has(place)) places.push(place);
  }
  return places;
}
