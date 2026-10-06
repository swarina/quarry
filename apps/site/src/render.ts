import type { QueryResult, ResultRow, ShardQuestion } from "@quarry/search-index";
import { type CriterionEstimate, draftOptions, MAX_POSTINGS, usd } from "./criteria.ts";
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
import { answeredAmong, type Held, readingOf } from "./held.ts";
import {
  activeFilters,
  answerFilter,
  askable,
  PAGE,
  type SearchState,
  setAnswerFilter,
  setCriterionFilter,
  toggle,
} from "./state.ts";

export interface View {
  readonly state: SearchState;
  readonly result: QueryResult;
  /** Apply links, once they have arrived; a posting without one yet is not a link. */
  readonly links: ReadonlyMap<string, string>;
  /** The standard questions the loaded index carries, which is what names them. */
  readonly questions: readonly ShardQuestion[];
  /** What the criterion has answered in this session, if it has been asked. */
  readonly held: Held | undefined;
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
  const mine = criterionTag(row, view);
  if (mine !== undefined) facts.push(mine);

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

/**
 * What your own question answered about a posting, shown the same way a standard answer is: the
 * likeliest option as a band, with the figure in the title text.
 *
 * Unlike a standard answer, an unlikely one is still shown. There the model is one of several
 * speaking about a posting and a spread answer is noise; here it is the only answer to the thing
 * that was just asked, and silently omitting it would read as "not asked" when the truth is "the
 * model does not know". The tag says so instead.
 */
function criterionTag(row: ResultRow, view: View): HTMLElement | undefined {
  const held = view.held;
  if (held === undefined) return undefined;
  const reading = readingOf(held, row.id);
  if (reading === undefined) return undefined;
  const band = confidenceBand(reading.probability);
  const unsure = band.id === "unlikely";
  return el("span", {
    class: `answer answer-mine answer-${band.id}`,
    title:
      `${held.description.options.length > 2 ? "Your question" : "You asked"}: ` +
      `${reading.label}, ${reading.probability}% likely. Answered by a model just now, not ` +
      "stated by the employer.",
    text: unsure ? `${reading.label}? (unsure)` : `${reading.label} (${band.name})`,
  });
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

/**
 * The criterion as a filter: its options with counts, and the threshold they are counted at.
 *
 * The counts here are over the postings actually answered, not over the whole result, and the
 * line beneath says how many that is. While a run can stop early on its budget or its deadline
 * (ADR-0025) the two differ, and a count that quietly meant "of the ones we got to" would read
 * as a fact about the market.
 */
function criterionGroup(view: View, held: Held, go: Go): HTMLElement {
  const { state } = view;
  const filter = state.criterionFilter;
  const options = filter?.options ?? [];
  const atLeast = filter?.atLeast ?? THRESHOLDS[0] ?? 50;
  const criterion = state.criterion;
  if (criterion === null) return el("section");

  const ids = view.result.rows.map((row) => row.id);
  const counts = new Map<string, number>();
  for (const id of ids) {
    const reading = readingOf(held, id);
    if (reading !== undefined) counts.set(reading.label, (counts.get(reading.label) ?? 0) + 1);
  }

  const items = draftOptions(criterion).map((option) => {
    const input = el("input", {
      type: "checkbox",
      class: "facet-box",
      checked: options.includes(option.id),
    });
    input.addEventListener("change", () =>
      go(setCriterionFilter(state, toggle(options, option.id), atLeast)),
    );
    return el("li", {}, [
      el("label", { class: "facet" }, [
        input,
        el("span", { class: "facet-name", text: option.label }),
        el("span", {
          class: "facet-count",
          text: number(counts.get(option.label) ?? 0, view.locale),
        }),
      ]),
    ]);
  });

  const select = el(
    "select",
    { id: "threshold-criterion", class: "threshold" },
    THRESHOLDS.map((value) =>
      el("option", { value: String(value), selected: value === atLeast, text: `${value}%` }),
    ),
  );
  select.addEventListener("change", () =>
    go(setCriterionFilter(state, options, Number((select as HTMLSelectElement).value))),
  );

  return el("section", { class: "facet-group answers answers-mine" }, [
    el("h2", { text: "Your question" }),
    el("p", { class: "criterion-wording", text: criterion.question }),
    el("ul", {}, items),
    el("p", { class: "threshold-row" }, [
      el("label", { for: "threshold-criterion", text: "At least " }),
      select,
      el("span", { text: " likely" }),
    ]),
    el("p", {
      class: "answered",
      text: `${number(answeredAmong(held, ids), view.locale)} of these postings have been answered.`,
    }),
  ]);
}

/** Every facet, counted over the postings the other filters let through. */
export function renderFacets(view: View, go: Go): (Node | string)[] {
  const { facets } = view.result;
  return [
    ...(view.held === undefined ? [] : [criterionGroup(view, view.held, go)]),
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

/** Everything the ask panel needs to say that is not in the search itself. */
export interface AskState {
  /** Whether a secret has been given. Nothing can be asked without one. */
  readonly unlocked: boolean;
  /** How many postings the other filters leave, which is what would be asked about. */
  readonly total: number;
  /** What asking would cost, once the question is complete enough to price. */
  readonly estimate: CriterionEstimate | undefined;
  /** Set while a request is in flight, so the button cannot be pressed twice. */
  readonly busy: boolean;
  /** What is wrong with the question as written, if anything. */
  readonly problem: string | undefined;
  /** What happened last: a refusal, a failure, or a run that stopped early. */
  readonly message: string | undefined;
}

/**
 * The line under the question: what asking would cost, or why it cannot be asked yet.
 *
 * The estimate is shown as soon as the question is complete, because estimating spends nothing
 * and a cost that appears only after a confirmation step is a cost that surprises someone. There
 * is deliberately no confirmation dialogue: a page of results is cents (ADR-0027), and the whole
 * point of asking only what the filters leave is that it can feel like search rather than like
 * submitting a job.
 */
export function renderAskStatus(ask: AskState, view: View): (Node | string)[] {
  const nodes: (Node | string)[] = [];
  const say = (text: string, kind = "ask-note") => nodes.push(el("p", { class: kind, text }));

  if (!askable(ask.total)) {
    say(
      ask.total === 0
        ? "No postings match, so there is nothing to ask about."
        : `${number(ask.total, view.locale)} postings match. Narrow the search to ${number(MAX_POSTINGS, view.locale)} or fewer, then ask.`,
      "ask-blocked",
    );
  } else if (ask.problem !== undefined) {
    say(ask.problem, "ask-blocked");
  } else if (!ask.unlocked) {
    say("Asking spends money, so it needs the shared secret.", "ask-blocked");
  } else if (ask.busy) {
    say("Asking. This takes a few seconds.");
  } else if (ask.estimate !== undefined) {
    const { estimate } = ask;
    const already =
      estimate.cached === 0
        ? ""
        : ` ${number(estimate.cached, view.locale)} of ${number(estimate.wanted, view.locale)} are already answered, and cost nothing.`;
    say(
      estimate.toAsk === 0
        ? `All ${number(estimate.wanted, view.locale)} are already answered. Asking costs nothing.`
        : `Asking ${number(estimate.postings, view.locale)} postings costs about ${usd(estimate.nanoUsd)}.${already}`,
      "ask-cost",
    );
  }

  if (ask.message !== undefined) say(ask.message, "ask-problem");
  if (view.held !== undefined && !ask.busy) {
    say(
      "These answers are held for this page only. Reloading loses them, and asking again is free.",
    );
  }
  return nodes;
}
