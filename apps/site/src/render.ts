import type { QueryResult, ResultRow } from "@quarry/search-index";
import { el } from "./dom.ts";
import {
  countryName,
  EMPLOYMENT_NAMES,
  number,
  pay,
  posted,
  WORKPLACE_NAMES,
  where,
} from "./format.ts";
import { activeFilters, PAGE, type SearchState, toggle } from "./state.ts";

export interface View {
  readonly state: SearchState;
  readonly result: QueryResult;
  /** Apply links, once they have arrived; a posting without one yet is not a link. */
  readonly links: ReadonlyMap<string, string>;
  readonly now: number;
  readonly locale: string | undefined;
}

type Go = (state: SearchState) => void;

/** One result. The description is deliberately not here: we link to the source (product 7.4). */
function resultItem(row: ResultRow, view: View): HTMLElement {
  const url = view.links.get(row.id);
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
  const filters = activeFilters(view.state);
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
  const filters = activeFilters(view.state);
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
  ];
}
