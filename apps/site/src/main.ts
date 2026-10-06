import type { Manifest, QueryResult } from "@quarry/search-index";
import { queryIndex } from "@quarry/search-index";
import {
  type Catalog,
  defaultRegion,
  loadLinks,
  loadManifest,
  loadRegion,
  regionChoices,
} from "./catalog.ts";
import { lock, NotUnlockedError, unlock, unlocked } from "./credentials.ts";
import {
  ask as askServer,
  CriteriaRequestError,
  type CriterionDraft,
  type CriterionEstimate,
  draftProblem,
  estimate as estimateServer,
  MAX_POSTINGS,
  stoppedBecause,
} from "./criteria.ts";
import { byId, el, fill } from "./dom.ts";
import { number } from "./format.ts";
import { type Held, keep, merge, passes } from "./held.ts";
import {
  type AskState,
  renderActive,
  renderAskStatus,
  renderFacets,
  renderResults,
  type View,
} from "./render.ts";
import {
  askable,
  EMPTY,
  fromUrl,
  PAGE,
  type SearchState,
  setCriterion,
  toQuery,
  toQueryString,
} from "./state.ts";

/** A build's files never change, so they are cached hard; the manifest names the build. */
const BASE = "index";

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return await response.json();
}

/** A posting is stale when the crawl that found it is old; the banner says so. */
const STALE_HOURS = 36;

let manifest: Manifest | undefined;
let catalog: Catalog | undefined;
let links = new Map<string, string>();
let state: SearchState = EMPTY;
const locale = typeof navigator === "undefined" ? undefined : navigator.language;

/** What the criterion has answered, and the editor state around asking it. All in memory. */
let held: Held | undefined;
let estimate: CriterionEstimate | undefined;
let askMessage: string | undefined;
let busy = false;
/** The pick-one options or scale levels being edited, owned here rather than re-read from state. */
let choices: string[] = [];

function view(result: QueryResult): View {
  return {
    state,
    result,
    links,
    // The loaded index is what knows the questions, their options, and what they are called.
    questions: catalog?.table.questions ?? [],
    held,
    now: Date.now(),
    locale,
  };
}

/**
 * Narrows a result by what the criterion answered.
 *
 * This happens over the rows rather than inside the query, because the criterion is not in the
 * index and cannot be: the index is a build artifact everyone shares, and this is one person's
 * question about one page of results. That is affordable only because the question can only be
 * asked below the posting cap, so one query returns every matching row and filtering them is
 * filtering the whole result.
 *
 * The facet counts are left as the index computed them, so they describe the search without the
 * criterion. Making them agree would mean counting every facet over the narrowed rows here,
 * which is the index's job done worse.
 */
function narrow(result: QueryResult, answers: Held): QueryResult {
  const filter = state.criterionFilter;
  if (filter === null) return result;
  const kept = result.rows.filter((row) => passes(answers, row.id, filter));
  return { ...result, total: kept.length, rows: kept.slice(0, state.shown) };
}

function draw(): void {
  if (catalog === undefined) return;
  const started = performance.now();
  const query = toQuery(state, Date.now());
  const narrowing = state.criterionFilter !== null && held !== undefined;
  // Narrowing needs every matching row, not the page being looked at, so it is asked for whole.
  const base = queryIndex(catalog.table, narrowing ? { ...query, limit: MAX_POSTINGS } : query);
  const result = held !== undefined ? narrow(base, held) : base;
  const took = performance.now() - started;
  const current = view(result);

  fill(byId("results"), renderResults(current, go));
  fill(byId("facets"), renderFacets(current, go));
  fill(byId("active"), renderActive(current, go));
  byId("count").textContent = result.total === 1 ? "1 job" : `${number(result.total, locale)} jobs`;
  byId("timing").textContent = `filtered in ${took.toFixed(1)} ms`;
  const search = byId<HTMLInputElement>("text");
  if (search.value !== state.text) search.value = state.text;
  byId<HTMLSelectElement>("sort").value = state.sort;
  byId<HTMLSelectElement>("region").value = state.region;
  // The criterion is asked of what the other filters leave, so its total is the unnarrowed one.
  drawAsk(current, base.total);
}

/** The postings a criterion would be asked about: every row the other filters leave. */
function askIds(): readonly string[] {
  if (catalog === undefined) return [];
  const query = { ...toQuery(state, Date.now()), limit: MAX_POSTINGS };
  return queryIndex(catalog.table, query).rows.map((row) => row.id);
}

/** The panel's own parts: what can be pressed, and what it says. */
function drawAsk(current: View, total: number): void {
  const problem = state.criterion === null ? undefined : draftProblem(state.criterion);
  const ask: AskState = {
    unlocked: unlocked(),
    total,
    estimate,
    busy,
    problem,
    message: askMessage,
  };
  fill(byId("ask-status"), renderAskStatus(ask, current));
  const button = byId<HTMLButtonElement>("criterion-ask");
  button.disabled =
    busy || !unlocked() || state.criterion === null || problem !== undefined || !askable(total);
  button.textContent = busy ? "Asking" : "Ask";
  byId<HTMLButtonElement>("criterion-clear").hidden = state.criterion === null;
  byId<HTMLButtonElement>("criterion-lock").hidden = !unlocked();
  // The box goes once the secret is held, so there is nothing on screen to read it back out of.
  byId<HTMLFormElement>("unlock").hidden = unlocked();
}

/** Every change goes through here, so the URL and the page can never disagree. */
function go(next: SearchState, replace = false): void {
  const changedRegion = next.region !== state.region;
  state = next;
  const url = `${globalThis.location.pathname}${toQueryString(state)}`;
  if (replace) globalThis.history.replaceState(null, "", url);
  else globalThis.history.pushState(null, "", url);
  if (changedRegion) void switchRegion();
  else draw();
}

/** Two drafts are the same question when every word of them is (ADR-0024). */
function sameDraft(left: CriterionDraft | null, right: CriterionDraft | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.question === right.question &&
    left.choices.length === right.choices.length &&
    left.choices.every((choice, at) => choice === right.choices[at])
  );
}

/** The question as the boxes currently read, or nothing when none has been written. */
function readDraft(): CriterionDraft | null {
  const question = byId<HTMLTextAreaElement>("criterion-question").value.trim();
  if (question === "") return null;
  const kind = byId<HTMLSelectElement>("criterion-kind").value as CriterionDraft["kind"];
  return { kind, question, choices: kind === "yes-no" ? [] : choices.map((value) => value.trim()) };
}

/**
 * Takes the question from the boxes into the search.
 *
 * Held answers go when the wording changes, because they are answers to the previous question
 * and keeping them would label postings with a reading of something nobody asked (ADR-0024).
 */
function commitDraft(): void {
  const draft = readDraft();
  if (sameDraft(draft, state.criterion)) return;
  held = undefined;
  estimate = undefined;
  askMessage = undefined;
  go(setCriterion(state, draft), true);
  scheduleEstimate();
}

/** The option or level boxes. Rebuilt only when their number changes, so typing is not cut off. */
function drawChoices(): void {
  const kind = byId<HTMLSelectElement>("criterion-kind").value;
  const host = byId("criterion-choices");
  if (kind === "yes-no") {
    fill(host, []);
    return;
  }
  const scale = kind === "scale";
  const rows = choices.map((value, at) => {
    const input = el("input", {
      type: "text",
      class: "choice",
      value,
      "aria-label": scale ? `Level ${at + 1}, lowest first` : `Option ${at + 1}`,
      placeholder: scale ? (at === 0 ? "lowest" : "higher") : "an answer",
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      choices[at] = input.value;
      commitDraft();
    });
    const remove = el("button", {
      type: "button",
      class: "link",
      text: "Remove",
      "aria-label": `Remove ${scale ? "level" : "option"} ${at + 1}`,
    });
    remove.addEventListener("click", () => {
      choices.splice(at, 1);
      drawChoices();
      commitDraft();
    });
    // Two is the fewest either kind can have, so the last two cannot be removed.
    if (choices.length <= 2) remove.setAttribute("hidden", "");
    return el("li", { class: "choice-row" }, [input, remove]);
  });
  const add = el("button", {
    type: "button",
    class: "link",
    text: scale ? "Add a level" : "Add an option",
  });
  add.addEventListener("click", () => {
    choices.push("");
    drawChoices();
  });
  fill(host, [
    el("ul", { class: "choices" }, rows),
    el("p", { class: "ask-actions" }, [add]),
    el("p", {
      class: "ask-note",
      text: scale
        ? "Levels are read lowest first, and the model answers with the one that fits."
        : "The model picks one of these, and says how likely each is.",
    }),
  ]);
}

/**
 * Prices the question a moment after it stops changing.
 *
 * Estimating spends nothing, so it can follow typing. It is debounced anyway because it is a
 * request per keystroke otherwise, and the rate limit it would spend is shared with asking.
 */
let pricing: ReturnType<typeof setTimeout> | undefined;

function scheduleEstimate(): void {
  clearTimeout(pricing);
  estimate = undefined;
  pricing = setTimeout(() => void refreshEstimate(), 400);
}

async function refreshEstimate(): Promise<void> {
  const draft = state.criterion;
  if (draft === null || !unlocked() || draftProblem(draft) !== undefined) return;
  const ids = askIds();
  if (!askable(ids.length)) return;
  try {
    const reply = await estimateServer(draft, ids, send);
    // The question may have moved on while this was in flight; a price for an older wording
    // would be a price for a different question.
    if (sameDraft(draft, state.criterion)) {
      estimate = reply.estimate;
      askMessage = undefined;
      draw();
    }
  } catch (caught) {
    askMessage = asMessage(caught);
    draw();
  }
}

/** Sends a request to this origin. Declared here so a test can drive the page without a network. */
const send = (path: string, init: RequestInit): Promise<Response> => fetch(path, init);

function asMessage(caught: unknown): string {
  if (caught instanceof CriteriaRequestError) {
    if (caught.code === "UNAUTHORIZED") return "That secret was not accepted.";
    if (caught.code === "UNREACHABLE") return "The asking service could not be reached.";
    return caught.message;
  }
  if (caught instanceof NotUnlockedError) return caught.message;
  return caught instanceof Error ? caught.message : String(caught);
}

/** Asks the question of everything the other filters leave, and keeps whatever comes back. */
async function runAsk(): Promise<void> {
  const draft = state.criterion;
  if (draft === null || busy) return;
  const ids = askIds();
  if (!askable(ids.length)) return;
  busy = true;
  askMessage = undefined;
  draw();
  try {
    const reply = await askServer(draft, ids, send);
    const arrived = keep(reply);
    if (arrived !== undefined && sameDraft(draft, state.criterion)) {
      held = merge(held, arrived);
    }
    askMessage = stoppedBecause(reply);
  } catch (caught) {
    askMessage = asMessage(caught);
  } finally {
    busy = false;
    draw();
  }
}

function wireAsk(): void {
  const question = byId<HTMLTextAreaElement>("criterion-question");
  let typing: ReturnType<typeof setTimeout> | undefined;
  question.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => commitDraft(), 300);
  });

  const kind = byId<HTMLSelectElement>("criterion-kind");
  kind.addEventListener("change", () => {
    // A kind change starts the answers again: options and levels are not the same thing, and
    // carrying one across as the other would send words written for a different shape.
    choices = kind.value === "yes-no" ? [] : ["", ""];
    drawChoices();
    commitDraft();
  });

  byId("criterion-ask").addEventListener("click", () => void runAsk());
  byId("criterion-clear").addEventListener("click", () => {
    question.value = "";
    choices = kind.value === "yes-no" ? [] : ["", ""];
    drawChoices();
    commitDraft();
  });

  byId<HTMLFormElement>("unlock").addEventListener("submit", (event) => {
    event.preventDefault();
    const box = byId<HTMLInputElement>("criterion-secret");
    try {
      unlock(box.value);
      // The box is emptied the moment the secret is held, so it is not sitting in the page, in a
      // form restore, or in whatever a password manager would otherwise offer to keep.
      box.value = "";
      askMessage = undefined;
      scheduleEstimate();
    } catch (caught) {
      askMessage = asMessage(caught);
    }
    draw();
  });
  byId("criterion-lock").addEventListener("click", () => {
    lock();
    estimate = undefined;
    draw();
  });
}

/** Puts a question that arrived in a URL into the boxes, so a shared link opens ready to ask. */
function showDraft(): void {
  const draft = state.criterion;
  const question = byId<HTMLTextAreaElement>("criterion-question");
  const kind = byId<HTMLSelectElement>("criterion-kind");
  question.value = draft?.question ?? "";
  kind.value = draft?.kind ?? "yes-no";
  choices = draft === null || draft.kind === "yes-no" ? [] : [...draft.choices];
  if (draft !== null && draft.kind !== "yes-no" && choices.length < 2) choices = ["", ""];
  drawChoices();
}

async function switchRegion(): Promise<void> {
  if (manifest === undefined) return;
  byId("status").textContent = "Loading postings";
  const loaded = await loadRegion(manifest, state.region, fetchJson);
  catalog = loaded.catalog;
  links = new Map();
  byId("status").textContent = "";
  draw();
  void loadLinks(loaded.ids, fetchJson).then((found) => {
    links = found;
    draw();
  });
}

function wire(loaded: Manifest): void {
  const search = byId<HTMLInputElement>("text");
  let typing: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => go({ ...state, text: search.value, shown: PAGE }, true), 150);
  });
  byId<HTMLSelectElement>("sort").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    go({ ...state, sort: value === "pay" ? "pay" : "newest", shown: PAGE });
  });
  const regions = byId<HTMLSelectElement>("region");
  fill(
    regions,
    regionChoices(loaded).map((region) =>
      el("option", { value: region.id, text: `${region.name} (${number(region.rows, locale)})` }),
    ),
  );
  regions.addEventListener("change", (event) => {
    go({ ...EMPTY, region: (event.target as HTMLSelectElement).value });
  });
  globalThis.addEventListener("popstate", () => {
    const before = state.criterion;
    state = fromUrl(new URL(globalThis.location.href), { ...EMPTY, region: defaultRegion() });
    if (!sameDraft(before, state.criterion)) {
      held = undefined;
      estimate = undefined;
      showDraft();
    }
    void switchRegion();
  });
  wireAsk();
}

async function start(): Promise<void> {
  manifest = await loadManifest(fetchJson);
  state = fromUrl(new URL(globalThis.location.href), { ...EMPTY, region: defaultRegion() });
  // Write the region the page settled on into the URL, so the first link copied is shareable.
  globalThis.history.replaceState(
    null,
    "",
    `${globalThis.location.pathname}${toQueryString(state)}`,
  );
  wire(manifest);
  showDraft();
  const loaded = await loadRegion(manifest, state.region, fetchJson);
  catalog = loaded.catalog;
  byId("status").textContent = "";
  draw();
  const built = new Date(manifest.builtAt).getTime();
  if (Date.now() - built > STALE_HOURS * 60 * 60 * 1000) {
    byId("stale").textContent = `These postings were last updated ${new Date(
      manifest.builtAt,
    ).toLocaleString(locale)}, which is longer ago than usual.`;
  }
  void loadLinks(loaded.ids, fetchJson).then((found) => {
    links = found;
    draw();
  });
}

start().catch((error: unknown) => {
  byId("status").textContent = `Could not load the postings: ${
    error instanceof Error ? error.message : String(error)
  }`;
});
