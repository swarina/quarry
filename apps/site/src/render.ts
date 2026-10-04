import type { QueryResult, ResultRow, ShardQuestion } from "@quarry/search-index";
import { el } from "./dom.ts";
import {
  confidenceBand,
  countryName,
  EMPLOYMENT_NAMES,
  number,
  pay,
  posted,
  WORKPLACE_NAMES,
  where,
} from "./format.ts";
import {
  activeFilters,
  answerFilter,
  PAGE,
  type SearchState,
  setAnswerFilter,
  toggle,
} from "./state.ts";

export interface View {
  readonly state: SearchState;
  readonly result: QueryResult;
  /** Apply links, once they have arrived; a posting without one yet is not a link. */
  readonly links: ReadonlyMap<string, string>;
  /** The standard questions the loaded index carries, which is what names them. */
  readonly questions: readonly ShardQuestion[];
  readonly now: number;
  readonly locale: string | undefined;
}

/** The thresholds offered, as the honest range: more likely than not, up to near certainty. */
const THRESHOLDS = [50, 60, 70, 80, 90];

type Go = (state: SearchState) => void;

/** One result. The description is deliberately not here: we link to the source (product 7.4). */
function resultItem(row: ResultRow, view: View): HTMLElement {
  // An empty URL would be a link to nowhere, so it counts as not having one.
  const url = view.links.get(row.id) || undefined;
  const title = el("span", { class: "title", text: row.title });
  const facts: (Node | string)[] = [el("span", { class: "where", text: where(row, view.locale) })];
  if (row.inferred) {
    facts.push(
      el("span", {
        class: "inferred",
        title: "The posting names no place; this is where the company is based.",
        text: "inferred",
      }),
    );
  }
  if (row.workplace !== null) {
    facts.push(el("span", { class: "tag", text: WORKPLACE_NAMES[row.workplace] }));
  }
  for (const type of row.employmentTypes) {
    facts.push(el("span", { class: "tag", text: EMPLOYMENT_NAMES[type] }));
  }
  const money = pay(row, view.locale);
  if (money !== null) facts.push(el("span", { class: "pay", text: money }));
  for (const node of answerTags(row, view.questions)) facts.push(node);

  return el("li", { class: "result" }, [
    el("h3", {}, [
      url === undefined
        ? title
        : el("a", { href: url, rel: "noopener noreferrer nofollow", target: "_blank" }, [title]),
    ]),
    el("p", { class: "company" }, [
      el("button", {
        type: "button",
        class: "link",
        text: row.company,
        "aria-label": `Show only jobs at ${row.company}`,
      }),
    ]),
    el("p", { class: "facts" }, facts),
    el("p", { class: "posted", text: posted(row.postedDay, view.now, view.locale) }),
  ]);
}

/**
 * What the model said about a posting: the likeliest option, with how sure it is as a band
 * rather than a number. The exact probability is in the title text, so the claim is available
 * without being the first thing read.
 *
 * An unlikely answer is left out. A band of "unlikely" on the model's own best guess means the
 * answer is spread across the options, which is not a fact about the job, and showing it would
 * read as one.
 */
function answerTags(row: ResultRow, questions: readonly ShardQuestion[]): HTMLElement[] {
  const tags: HTMLElement[] = [];
  for (const answer of row.answers) {
    const question = questions.find((entry) => entry.id === answer.question);
    if (question === undefined) continue;
    const band = confidenceBand(answer.probability);
    if (band.id === "unlikely") continue;
    const at = question.options.indexOf(answer.option);
    const label = at < 0 ? answer.option : (question.labels[at] ?? answer.option);
    tags.push(
      el("span", {
        class: `answer answer-${band.id}`,
        title: `${question.about}: ${label}, ${answer.probability}% likely. Answered by a model, not stated by the employer.`,
        text: `${label} (${band.name})`,
      }),
    );
  }
  return tags;
}

/** The results list, with a button to show more when there are more. */
export function renderResults(view: View, go: Go): (Node | string)[] {
  const { result, state } = view;
  if (result.total === 0) return [emptyState(view, go)];
  const list = el(
    "ul",
    { class: "results" },
    result.rows.map((row) => {
      const item = resultItem(row, view);
      const company = item.querySelector("button.link");
      company?.addEventListener("click", () =>
        go({ ...state, companies: toggle(state.companies, row.company), shown: PAGE }),
      );
      return item;
    }),
  );
  const nodes: (Node | string)[] = [list];
  if (result.rows.length < result.total) {
    const more = el("button", {
      type: "button",
      class: "more",
      text: `Show more (${number(result.total - result.rows.length, view.locale)} to go)`,
    });
    more.addEventListener("click", () => go({ ...state, shown: state.shown + PAGE }));
    nodes.push(more);
  }
  return nodes;
}

/** Nothing matched: say which filter is doing the most damage and offer to drop it. */
function emptyState(view: View, go: Go): HTMLElement {
  const filters = activeFilters(view.state, view.questions);
  const nodes: (Node | string)[] = [el("p", { text: "No jobs match every filter." })];
  if (filters.length > 0) {
    const drop = el("button", {
      type: "button",
      class: "more",
      text: `Drop the last filter (${filters[filters.length - 1]?.label ?? ""})`,
    });
    drop.addEventListener("click", () => go(filters[filters.length - 1]?.without ?? view.state));
    nodes.push(drop);
  }
  return el("div", { class: "empty" }, nodes);
}

/** The filters in force, each removable, so it is always clear what is narrowing the list. */
export function renderActive(view: View, go: Go): (Node | string)[] {
  const filters = activeFilters(view.state, view.questions);
  if (filters.length === 0) return [];
  return [
    el("h2", { class: "sr-only", text: "Filters in force" }),
    el(
      "ul",
      { class: "chips" },
      filters.map((filter) => {
        const button = el(
          "button",
          {
            type: "button",
            class: "chip",
            "aria-label": `Remove filter ${filter.label}`,
          },
          [el("span", { text: filter.label }), el("span", { "aria-hidden": "true", text: "×" })],
        );
        button.addEventListener("click", () => go(filter.without));
        return el("li", {}, [button]);
      }),
    ),
  ];
}

interface FacetGroup<T extends string> {
  readonly title: string;
  readonly counts: readonly (readonly [T, number])[];
  readonly chosen: readonly T[];
  readonly name: (value: T) => string;
  readonly pick: (values: readonly T[]) => Partial<SearchState>;
}

function facetGroup<T extends string>(group: FacetGroup<T>, view: View, go: Go): HTMLElement {
  const shown = group.counts.slice(0, 12);
  const items = shown.map(([value, count]) => {
    const input = el("input", {
      type: "checkbox",
      class: "facet-box",
      checked: group.chosen.includes(value),
    });
    input.addEventListener("change", () =>
      go({ ...view.state, ...group.pick(toggle(group.chosen, value)), shown: PAGE }),
    );
    return el("li", {}, [
      el("label", { class: "facet" }, [
        input,
        el("span", { class: "facet-name", text: group.name(value) }),
        el("span", { class: "facet-count", text: number(count, view.locale) }),
      ]),
    ]);
  });
  return el("section", { class: "facet-group" }, [
    el("h2", { text: group.title }),
    el("ul", {}, items),
  ]);
}

/**
 * One standard question as a filter: its options with counts, and the threshold they are
 * counted at. The number of postings holding any answer is shown as well, because while the
 * corpus is only partly enriched the counts are otherwise misleading: options adding up to far
 * fewer than the results mean most postings have not been asked, not that an answer is rare.
 */
function answerGroup(question: ShardQuestion, view: View, go: Go): HTMLElement {
  const { state } = view;
  const facet = view.result.facets.answers.find((entry) => entry.question === question.id);
  const chosen = answerFilter(state, question.id);
  const options = chosen?.options ?? [];
  const atLeast = chosen?.atLeast ?? THRESHOLDS[0] ?? 50;
  const counts = new Map(facet?.options ?? []);

  const items = question.options.map((option, at) => {
    const input = el("input", {
      type: "checkbox",
      class: "facet-box",
      checked: options.includes(option),
    });
    input.addEventListener("change", () =>
      go(setAnswerFilter(state, question.id, toggle(options, option), atLeast)),
    );
    return el("li", {}, [
      el("label", { class: "facet" }, [
        input,
        el("span", { class: "facet-name", text: question.labels[at] ?? option }),
        el("span", { class: "facet-count", text: number(counts.get(option) ?? 0, view.locale) }),
      ]),
    ]);
  });

  const selectId = `threshold-${question.id}`;
  const select = el(
    "select",
    { id: selectId, class: "threshold" },
    THRESHOLDS.map((value) =>
      el("option", { value: String(value), selected: value === atLeast, text: `${value}%` }),
    ),
  );
  select.addEventListener("change", () => {
    const value = Number((select as HTMLSelectElement).value);
    go(setAnswerFilter(state, question.id, options, value));
  });

  const nodes: (Node | string)[] = [
    el("h2", { text: question.about }),
    el("ul", {}, items),
    el("p", { class: "threshold-row" }, [
      el("label", { for: selectId, text: "At least " }),
      select,
      el("span", { text: " likely" }),
    ]),
  ];
  if (facet !== undefined) {
    nodes.push(
      el("p", {
        class: "answered",
        text: `${number(facet.answered, view.locale)} of these postings have been asked.`,
      }),
    );
  }
  return el("section", { class: "facet-group answers" }, nodes);
}

/** Every facet, counted over the postings the other filters let through. */
export function renderFacets(view: View, go: Go): (Node | string)[] {
  const { facets } = view.result;
  return [
    facetGroup(
      {
        title: "Country",
        counts: facets.countries,
        chosen: view.state.countries,
        name: (code) => countryName(code, view.locale),
        pick: (countries) => ({ countries }),
      },
      view,
      go,
    ),
    facetGroup(
      {
        title: "Arrangement",
        counts: facets.workplaces,
        chosen: view.state.workplaces,
        name: (value) => WORKPLACE_NAMES[value],
        pick: (workplaces) => ({ workplaces }),
      },
      view,
      go,
    ),
    facetGroup(
      {
        title: "Employment",
        counts: facets.employment,
        chosen: view.state.employment,
        name: (value) => EMPLOYMENT_NAMES[value],
        pick: (employment) => ({ employment }),
      },
      view,
      go,
    ),
    facetGroup(
      {
        title: "Company",
        counts: facets.companies,
        chosen: view.state.companies,
        name: (value) => value,
        pick: (companies) => ({ companies }),
      },
      view,
      go,
    ),
    ...view.questions.map((question) => answerGroup(question, view, go)),
  ];
}
