/**
 * The discoverability files a built site carries, and the two tags in the page that need to
 * know where the site lives.
 *
 * Everything here turns on one fact about this site: it is a single document, and the whole
 * search state lives in the query string (ADR-0023). `?region=europe` and `?region=asia` are
 * the same document, served byte for byte, differing only in what the browser draws after it
 * fetches the index. So there is exactly one page here to offer a crawler, and the query-string
 * space around it is an unbounded set of views of it, not a set of pages. The canonical link
 * and the sitemap both say so, and the sitemap holds one URL rather than a region list, which
 * would be the same document submitted several times over.
 *
 * The absolute URL these need does not exist yet: the site is not deployed and has no domain.
 * Rather than guess one, the build takes `--base-url` and leaves out what it cannot state
 * truthfully without it.
 */

/** Where a deployed site lives: an absolute origin with no trailing slash, as a build gives it. */
export interface SiteUrl {
  readonly origin: string;
}

/**
 * Reads a `--base-url` value, rejecting anything a canonical link could not carry.
 *
 * A relative or malformed value would produce a canonical link pointing nowhere, which is worse
 * than no canonical link at all, so this throws rather than warning.
 */
export function readSiteUrl(value: string): SiteUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`--base-url must be an absolute URL, not ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--base-url must be http or https, not ${parsed.protocol}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("--base-url must not carry a query string or a fragment");
  }
  if (parsed.pathname !== "/") {
    throw new Error(`--base-url must be an origin, not a path (${parsed.pathname})`);
  }
  return { origin: parsed.origin };
}

/** The one page this site has. Every other URL is a view of it under a query string. */
export function pageUrl(site: SiteUrl): string {
  return `${site.origin}/`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `robots.txt`.
 *
 * Two paths are kept out. `/criteria/` is the Worker, not content: every request there spends
 * real money against a daily cap (ADR-0029), and there is nothing to read at it. `bench.html`
 * is a timing harness, which would otherwise be indexed as a thin second copy of the page.
 *
 * `/index/` is deliberately left open. It is the JSON the page fetches to draw anything at all,
 * so a crawler that renders the page needs it; blocking it would save bandwidth and leave the
 * one page here rendering as a loading state.
 *
 * The `Sitemap:` line needs an absolute URL, so a build with no `--base-url` writes the file
 * without it rather than pointing at a host that does not exist.
 */
export function renderRobotsFile(site?: SiteUrl): string {
  const lines = [
    "# Quarry is one page, and the whole search state is in the query string, so every",
    "# ?... URL here serves the same document. The canonical link in the page says so.",
    "User-agent: *",
    "Allow: /",
    "",
    "# The Worker, not content: each request costs against a daily cap.",
    "Disallow: /criteria/",
    "",
    "# A timing harness, not content.",
    "Disallow: /bench.html",
  ];
  if (site !== undefined) lines.push("", `Sitemap: ${site.origin}/sitemap.xml`);
  return `${lines.join("\n")}\n`;
}

/**
 * `sitemap.xml`, holding the single URL this site has.
 *
 * `lastModified` is the index build time when the build was given an index, because the page's
 * own bytes do not change when the postings do: what a visitor reads is the index, so that is
 * the date that means anything here. A build with no index leaves the field out.
 */
export function renderSitemapFile(site: SiteUrl, lastModified?: string): string {
  const entry = [`    <loc>${escapeXml(pageUrl(site))}</loc>`];
  if (lastModified !== undefined) entry.push(`    <lastmod>${escapeXml(lastModified)}</lastmod>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url>",
    ...entry,
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * Adds the two head tags that cannot be written until the site has an address: the canonical
 * link, and `og:url`.
 *
 * The canonical URL is the root, not the URL being visited. A single-page site whose state is
 * all query string has no per-view canonical to give: the view is drawn by script after load,
 * and a canonical set from the current URL at runtime would declare every filter permutation
 * canonical to itself, which is the duplication a canonical link exists to prevent.
 */
export function withSiteTags(html: string, site: SiteUrl): string {
  const url = escapeXml(pageUrl(site));
  const tags = [
    `    <link rel="canonical" href="${url}" />`,
    `    <meta property="og:url" content="${url}" />`,
  ].join("\n");
  const head = html.indexOf("  </head>");
  if (head === -1) throw new Error("index.html has no </head> to add the canonical tags before");
  return `${html.slice(0, head)}${tags}\n${html.slice(head)}`;
}
