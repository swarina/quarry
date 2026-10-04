import {
  ANSWER_FACETS_VERSION,
  deriveFacets,
  isPlaceholder,
  readAnswer,
  STRUCTURED_FACETS_VERSION,
} from "@quarry/facets";
import { answerShapes } from "@quarry/questions";
import type { ShardQuestion } from "@quarry/search-index";
import { buildIndex, type IndexBuild, type IndexRow } from "@quarry/search-index/build";
import type { PipelineStore } from "@quarry/storage/node";

/** What a build of the search index held, and how well postings were placed. */
export interface SearchIndexReport {
  readonly build: string;
  readonly postings: number;
  /** Templates and tests published by mistake, left out of the index. */
  readonly placeholders: number;
  /**
   * Postings placed by their labels, by structured fields, by their company's home country
   * (inferred), or not at all.
   */
  readonly byBasis: Readonly<Record<"labels" | "structured" | "home" | "none", number>>;
  readonly withCity: number;
  readonly anywhere: number;
  /**
   * How many indexed postings hold an answer to each standard question, and how many stored
   * answers could not be read. An unreadable answer is counted rather than hidden: it means a
   * stored answer no longer matches the question's options, which is a reason to look.
   */
  readonly answered: Readonly<Record<string, number>>;
  readonly unreadableAnswers: number;
  /** Labels that named no place or arrangement, most common first. */
  readonly unplacedLabels: readonly (readonly [string, number])[];
  readonly shards: readonly {
    readonly path: string;
    readonly rows: number;
    readonly gzipBytes: number;
  }[];
  readonly overBudget: readonly string[];
}

/** Unplaced labels listed in the report. */
const UNPLACED_SHOWN = 15;

/**
 * Builds the search index from the postings boards list now: structured facets for each
 * (locations read from labels, offices, and addresses), then the shards and manifest.
 * Placeholders (templates and tests an employer published by mistake) are left out.
 */
export async function buildSearchIndex(
  store: PipelineStore,
  builtAt: number,
): Promise<{ readonly build: IndexBuild; readonly report: SearchIndexReport }> {
  const rows: IndexRow[] = [];
  const byBasis = { labels: 0, structured: 0, home: 0, none: 0 };
  let withCity = 0;
  let anywhere = 0;
  const unplaced = new Map<string, number>();
  let placeholders = 0;
  // The questions as they are worded now. Answers held under any other wording are left out,
  // so a rewording empties the columns rather than quietly changing what they mean.
  const shapes = answerShapes();
  const questions: ShardQuestion[] = shapes.map((shape) => ({
    id: shape.id,
    version: shape.version,
    about: shape.about,
    kind: shape.kind,
    options: shape.options,
    labels: shape.labels,
  }));
  const answered: Record<string, number> = Object.fromEntries(shapes.map((shape) => [shape.id, 0]));
  let unreadableAnswers = 0;
  for (const current of store.currentPostings()) {
    const { posting } = current;
    if (isPlaceholder(posting)) {
      placeholders += 1;
      continue;
    }
    const facets = deriveFacets(posting, { country: current.companyCountry });
    const { location } = facets;
    byBasis[location.basis] += 1;
    if (location.places.some((place) => place.city !== null)) withCity += 1;
    if (location.anywhere) anywhere += 1;
    for (const label of location.unplaced) unplaced.set(label, (unplaced.get(label) ?? 0) + 1);

    const answers: Record<string, readonly number[]> = {};
    for (const shape of shapes) {
      const stored = current.answers[`${shape.id}@${shape.version}`];
      if (stored === undefined) continue;
      const distribution = readAnswer(stored, shape.kind, shape.options);
      if (distribution === null) {
        unreadableAnswers += 1;
        continue;
      }
      answers[shape.id] = distribution;
      answered[shape.id] = (answered[shape.id] ?? 0) + 1;
    }

    rows.push({
      id: current.id,
      title: posting.title,
      company: current.company,
      locations: posting.locations,
      places: location.places,
      anywhere: location.anywhere,
      inferred: location.basis === "home",
      workplace: facets.workplace,
      employmentTypes: facets.employmentTypes,
      department: facets.department,
      pay: facets.pay,
      postedAt: facets.publishedAt ?? current.firstSeenAt,
      url: posting.url,
      answers,
    });
  }
  const build = await buildIndex(rows, {
    builtAt,
    facetsVersion: STRUCTURED_FACETS_VERSION,
    answersVersion: ANSWER_FACETS_VERSION,
    questions,
  });
  return {
    build,
    report: {
      build: build.manifest.build,
      postings: rows.length,
      placeholders,
      byBasis,
      withCity,
      anywhere,
      answered,
      unreadableAnswers,
      unplacedLabels: [...unplaced]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, UNPLACED_SHOWN),
      shards: build.manifest.regions.flatMap((region) =>
        region.shards.map(({ path, rows: count, gzipBytes }) => ({ path, rows: count, gzipBytes })),
      ),
      overBudget: build.overBudget,
    },
  };
}

/** The build as a Markdown section for the job summary. */
export function renderSearchIndexSummary(report: SearchIndexReport): string {
  const number = (value: number) => value.toLocaleString("en-US");
  const share = (value: number) =>
    report.postings === 0 ? "n/a" : `${((100 * value) / report.postings).toFixed(1)}%`;
  const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
  const placed = report.byBasis.labels + report.byBasis.structured + report.byBasis.home;
  const largest = report.shards.reduce((most, shard) => Math.max(most, shard.gzipBytes), 0);
  const total = report.shards.reduce((sum, shard) => sum + shard.gzipBytes, 0);
  const lines = [
    `### Search index \`${report.build}\``,
    "",
    `- ${number(report.postings)} postings: ${share(placed)} placed (${share(report.byBasis.labels)} by their labels, ${share(report.byBasis.structured)} only by offices, addresses, or a stated country, ${share(report.byBasis.home)} inferred from the company's home country), ${share(report.withCity)} to a city; ${number(report.anywhere)} open to anywhere.`,
    `- ${number(report.shards.length)} shards, ${kilobytes(total)} gzipped in all; the largest is ${kilobytes(largest)}.`,
  ];
  const answers = Object.entries(report.answered);
  if (answers.length > 0) {
    const asked = answers.map(([question, count]) => `${question} ${share(count)}`).join(", ");
    lines.push(`- Answered: ${asked} (of the postings in the index).`);
  }
  if (report.unreadableAnswers > 0) {
    lines.push(
      `- ${number(report.unreadableAnswers)} stored answers could not be read and were left out; a stored answer no longer matches its question's options.`,
    );
  }
  if (report.placeholders > 0) {
    lines.push(
      `- Left out ${number(report.placeholders)} templates and tests that employers published by mistake.`,
    );
  }
  if (report.unplacedLabels.length > 0) {
    lines.push(
      `- Labels that named no place, most common first: ${report.unplacedLabels
        .map(([label, count]) => `${label.replace(/[|`]/g, " ")} (${number(count)})`)
        .join(", ")}.`,
    );
  }
  if (report.overBudget.length > 0) {
    lines.push("", "**Over budget:**", "", ...report.overBudget.map((problem) => `- ${problem}`));
  }
  return `${lines.join("\n")}\n`;
}
