import type { Manifest } from "@quarry/search-index";
import { queryIndex } from "@quarry/search-index";
import {
  type Catalog,
  defaultRegion,
  loadLinks,
  loadManifest,
  loadRegion,
  regionChoices,
} from "./catalog.ts";
import { byId, el, fill } from "./dom.ts";
import { number } from "./format.ts";
import { renderActive, renderFacets, renderResults, type View } from "./render.ts";
import { EMPTY, fromUrl, PAGE, type SearchState, toQuery, toQueryString } from "./state.ts";

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

function view(result: ReturnType<typeof queryIndex>): View {
  return { state, result, links, now: Date.now(), locale };
}

function draw(): void {
  if (catalog === undefined) return;
  const started = performance.now();
  const result = queryIndex(catalog.table, toQuery(state, Date.now()));
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
    state = fromUrl(new URL(globalThis.location.href), { ...EMPTY, region: defaultRegion() });
    void switchRegion();
  });
}

async function start(): Promise<void> {
  manifest = await loadManifest(fetchJson);
  state = fromUrl(new URL(globalThis.location.href), { ...EMPTY, region: defaultRegion() });
  wire(manifest);
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
