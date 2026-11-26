import { describe, expect, it } from "vitest";
import {
  pageUrl,
  readSiteUrl,
  renderRobotsFile,
  renderSitemapFile,
  withSiteTags,
} from "./metadata.ts";

const SITE = readSiteUrl("https://jobs.example.test");

describe("reading the site address a build is given", () => {
  it("keeps the origin and drops a trailing slash", () => {
    expect(pageUrl(readSiteUrl("https://jobs.example.test/"))).toBe("https://jobs.example.test/");
  });

  it("refuses a relative value", () => {
    // A relative --base-url would produce a canonical link resolved against whatever page the
    // crawler happened to be on, which is worse than having no canonical link.
    expect(() => readSiteUrl("/jobs")).toThrow(/absolute URL/);
  });

  it("refuses a scheme a browser would not fetch the page over", () => {
    expect(() => readSiteUrl("ftp://example.test")).toThrow(/http or https/);
  });

  it("refuses a path, a query string or a fragment", () => {
    expect(() => readSiteUrl("https://example.test/site")).toThrow(/an origin, not a path/);
    expect(() => readSiteUrl("https://example.test/?a=1")).toThrow(/query string or a fragment/);
  });
});

describe("robots.txt", () => {
  it("allows the site and keeps crawlers off the Worker and the timing harness", () => {
    // Every request to /criteria/ spends against a daily cap (ADR-0029), and there is nothing
    // to read there. bench.html is a harness, which would index as a thin second page.
    const rendered = renderRobotsFile(SITE);
    expect(rendered).toContain("User-agent: *");
    expect(rendered).toContain("Allow: /");
    expect(rendered).toContain("Disallow: /criteria/");
    expect(rendered).toContain("Disallow: /bench.html");
  });

  it("leaves the index open, because rendering the page needs it", () => {
    // Blocking /index/ would save a crawler megabytes and leave the one page here rendering as
    // a loading state, which is not what a visitor sees.
    expect(renderRobotsFile(SITE)).not.toContain("Disallow: /index/");
  });

  it("points at the sitemap with an absolute URL", () => {
    expect(renderRobotsFile(SITE)).toContain("Sitemap: https://jobs.example.test/sitemap.xml");
  });

  it("leaves the sitemap line out when the build was given no address", () => {
    // The site has no domain yet. A Sitemap: line naming a guessed host points nowhere.
    const rendered = renderRobotsFile();
    expect(rendered).not.toContain("Sitemap:");
    expect(rendered).toContain("Allow: /");
  });
});

describe("sitemap.xml", () => {
  it("holds the one URL this site has", () => {
    // The whole search state is in the query string, so ?region=europe and ?region=asia are the
    // same document. Listing them would submit one page several times over.
    const rendered = renderSitemapFile(SITE, "2026-11-22T11:10:30.680Z");
    expect([...rendered.matchAll(/<loc>/g)]).toHaveLength(1);
    expect(rendered).toContain("<loc>https://jobs.example.test/</loc>");
    expect(rendered).not.toContain("region=");
  });

  it("dates the page by the index build, which is what a visitor reads", () => {
    const rendered = renderSitemapFile(SITE, "2026-11-22T11:10:30.680Z");
    expect(rendered).toContain("<lastmod>2026-11-22T11:10:30.680Z</lastmod>");
  });

  it("leaves lastmod out when the build shipped no index", () => {
    expect(renderSitemapFile(SITE)).not.toContain("lastmod");
  });

  it("declares the sitemap namespace and escapes what it puts in an element", () => {
    const rendered = renderSitemapFile(readSiteUrl("https://a-b.example.test"));
    expect(rendered).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(rendered.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("the tags that need the site's address", () => {
  const page = ["<html>", "  <head>", "    <title>Quarry</title>", "  </head>", "</html>"].join(
    "\n",
  );

  it("declares the root canonical, not the URL being visited", () => {
    // A view here is drawn by script from the query string after load. A canonical taken from
    // the current URL would declare every filter permutation canonical to itself, which is the
    // duplication a canonical link exists to prevent.
    const rendered = withSiteTags(page, SITE);
    expect(rendered).toContain('<link rel="canonical" href="https://jobs.example.test/" />');
    expect(rendered).toContain('<meta property="og:url" content="https://jobs.example.test/" />');
  });

  it("puts them inside the head", () => {
    const rendered = withSiteTags(page, SITE);
    expect(rendered.indexOf("canonical")).toBeLessThan(rendered.indexOf("</head>"));
  });

  it("fails loudly on a page it cannot place them in", () => {
    // Silently returning the page unchanged would ship a build with no canonical link and no
    // sign that anything was missing.
    expect(() => withSiteTags("<html></html>", SITE)).toThrow(/no <\/head>/);
  });
});
