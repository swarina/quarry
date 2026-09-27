import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { ALLOW_ALL, parseRobots, ROBOTS_MAX_BYTES } from "./robots.ts";

const allowed = (robots: string, path: string, token = "QuarryBot") =>
  parseRobots(robots, token).isAllowed(path);

describe("parseRobots", () => {
  it("reads the robots.txt files of the job board APIs we use (checked 2026-09-27)", () => {
    const greenhouse = "# See http://www.robotstxt.org\n\nUser-agent: *\nDisallow: /embed/\n";
    expect(allowed(greenhouse, "/v1/boards/stripe/jobs?content=true")).toBe(true);
    expect(allowed(greenhouse, "/embed/job_board?for=stripe")).toBe(false);

    const lever = "User-agent: *\nAllow: /\nCrawl-delay: 1\n";
    expect(allowed(lever, "/v0/postings/acme?mode=json")).toBe(true);
    expect(parseRobots(lever, "QuarryBot").crawlDelaySeconds).toBe(1);
  });

  it("prefers groups naming our product token over the * group", () => {
    const robots =
      "User-agent: *\nDisallow: /\n\nUser-agent: QuarryBot/1.0\nAllow: /jobs\nDisallow: /\n";
    expect(allowed(robots, "/jobs/1")).toBe(true);
    expect(allowed(robots, "/private")).toBe(false);
    expect(allowed(robots, "/jobs/1", "OtherBot")).toBe(false);
  });

  it("matches the product token case-insensitively and merges every matching group", () => {
    const robots = "User-agent: quarrybot\nDisallow: /a\n\nUser-agent: QUARRYBOT\nDisallow: /b\n";
    expect(allowed(robots, "/a")).toBe(false);
    expect(allowed(robots, "/b")).toBe(false);
    expect(allowed(robots, "/c")).toBe(true);
  });

  it("groups consecutive user-agent lines, even across other records", () => {
    const robots =
      "User-agent: OtherBot\nSitemap: https://example.com/sitemap.xml\nUser-agent: QuarryBot\nDisallow: /x\n" +
      "User-agent: ThirdBot\nDisallow: /y\n";
    expect(allowed(robots, "/x")).toBe(false);
    expect(allowed(robots, "/x", "OtherBot")).toBe(false);
    expect(allowed(robots, "/y")).toBe(true);
  });

  it("uses the longest matching rule, with allow winning ties", () => {
    const robots = "User-agent: *\nDisallow: /jobs\nAllow: /jobs/open\nAllow: /x\nDisallow: /x\n";
    expect(allowed(robots, "/jobs/closed")).toBe(false);
    expect(allowed(robots, "/jobs/open/1")).toBe(true);
    expect(allowed(robots, "/x")).toBe(true);
  });

  it("supports * wildcards and the $ end anchor", () => {
    const robots =
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/data\nAllow: /private-ok/data\n";
    expect(allowed(robots, "/files/cv.pdf")).toBe(false);
    expect(allowed(robots, "/files/cv.pdf?download=1")).toBe(true);
    expect(allowed(robots, "/private-area/data/1")).toBe(false);
    expect(allowed(robots, "/private-ok/data/1")).toBe(true);
  });

  it("ignores empty rules, comments, unknown records, and rules before any group", () => {
    const robots = "Disallow: /orphan\n# comment\nUser-agent: * # everyone\nDisallow:\nFoo: bar\n";
    expect(allowed(robots, "/orphan")).toBe(true);
    expect(allowed(robots, "/anything")).toBe(true);
  });

  it("compares percent-encoded and non-ASCII paths octet for octet", () => {
    const robots = "User-agent: *\nDisallow: /café\nDisallow: /a%2fb\n";
    expect(allowed(robots, "/caf%C3%A9/menu")).toBe(false);
    expect(allowed(robots, "/a%2Fb")).toBe(false);
  });

  it("always allows /robots.txt and allows everything without matching groups", () => {
    expect(allowed("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
    expect(allowed("User-agent: OtherBot\nDisallow: /\n", "/jobs")).toBe(true);
    expect(allowed("", "/jobs")).toBe(true);
  });

  it("takes the largest crawl delay among merged groups and ignores invalid values", () => {
    const robots =
      "User-agent: *\nCrawl-delay: 2\n\nUser-agent: *\nCrawl-delay: 0.5\nCrawl-delay: soon\n";
    expect(parseRobots(robots, "QuarryBot").crawlDelaySeconds).toBe(2);
    expect(parseRobots("User-agent: *\nAllow: /\n", "QuarryBot").crawlDelaySeconds).toBeUndefined();
  });

  it("ignores everything past the size limit", () => {
    const robots = `User-agent: *\n${"#".repeat(ROBOTS_MAX_BYTES)}\nDisallow: /late\n`;
    expect(allowed(robots, "/late")).toBe(true);
  });

  it("provides an allow-all policy", () => {
    expect(ALLOW_ALL.isAllowed("/x")).toBe(true);
    expect(ALLOW_ALL.crawlDelaySeconds).toBeUndefined();
  });

  it("decodes escaped unreserved characters and encodes unsafe ones before comparing", () => {
    expect(allowed("User-agent: *\nDisallow: /%7Euser\n", "/~user/profile")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /~admin\n", "/%7eadmin")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a b\n", "/a%20b")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /%2A\n", "/anything")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /%2A\n", "/%2a")).toBe(false);
  });

  test.prop([fc.stringMatching(/^\/[a-z*$/]{0,12}$/), fc.stringMatching(/^\/[a-z/]{0,40}$/)])(
    "agrees with a regular-expression reference matcher",
    (pattern, path) => {
      const anchored = pattern.endsWith("$");
      const body = (anchored ? pattern.slice(0, -1) : pattern)
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      const reference = new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
      expect(allowed(`User-agent: *\nDisallow: ${pattern}\n`, path)).toBe(!reference);
    },
  );
});
