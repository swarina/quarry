import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDenylist, parseSeeds, SeedsError } from "./seeds.ts";

describe("parseSeeds", () => {
  it("reads boards with an optional country", () => {
    const text = `
# Comments are allowed.
boards:
  - { source: greenhouse, slug: stripe, company: Stripe, country: US }
  - { source: lever-eu, slug: acme, company: "Acme, Inc." }
`;
    expect(parseSeeds(text)).toEqual([
      { source: "greenhouse", slug: "stripe", company: "Stripe", country: "US" },
      { source: "lever-eu", slug: "acme", company: "Acme, Inc.", country: null },
    ]);
  });

  it("names every problem", () => {
    const text = `
boards:
  - { source: workday, slug: acme, company: Acme }
  - { source: ashby, slug: "a b", company: Acme, country: usa }
  - { source: ashby, slug: fine, company: "  " }
  - { source: ashby, slug: extra, company: Extra, colour: blue }
`;
    const error = (() => {
      try {
        parseSeeds(text);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected an error");
    })();
    expect(error).toBeInstanceOf(SeedsError);
    expect(error.message).toContain("boards.yaml");
    for (const path of [
      "boards[0].source",
      "boards[1].slug",
      "boards[1].country",
      "boards[2].company",
    ]) {
      expect(error.message).toContain(path);
    }
    expect(error.message).toMatch(/Unrecognized key/);
  });

  it("rejects the same board listed twice, comparing slugs case-insensitively", () => {
    const text = `
boards:
  - { source: ashby, slug: Notion, company: Notion }
  - { source: ashby, slug: notion, company: Notion }
`;
    expect(() => parseSeeds(text)).toThrow(/listed more than once: ashby:notion/);
  });

  it("reports YAML syntax errors as seed errors", () => {
    expect(() => parseSeeds("boards: [unclosed")).toThrow(SeedsError);
    expect(() => parseSeeds("")).toThrow(SeedsError);
  });
});

describe("parseDenylist", () => {
  it("reads removal requests and accepts an empty list", () => {
    const text = `
boards:
  - { source: greenhouse, slug: optout, requested: 2026-10-01, reason: Company request }
`;
    expect(parseDenylist(text)).toEqual([{ source: "greenhouse", slug: "optout" }]);
    expect(parseDenylist("boards: []\n")).toEqual([]);
    expect(parseDenylist("boards:\n")).toEqual([]);
  });

  it("requires a date and a reason for every removal", () => {
    expect(() => parseDenylist("boards:\n  - { source: ashby, slug: x, reason: asked }\n")).toThrow(
      /requested/,
    );
    expect(() =>
      parseDenylist("boards:\n  - { source: ashby, slug: x, requested: soon, reason: asked }\n"),
    ).toThrow(/requested/);
  });
});

describe("the committed seed files", () => {
  const seedsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../seeds");

  it("parse cleanly", () => {
    expect(parseSeeds(readFileSync(join(seedsDir, "boards.yaml"), "utf8")).length).toBeGreaterThan(
      0,
    );
    expect(parseDenylist(readFileSync(join(seedsDir, "denylist.yaml"), "utf8"))).toBeInstanceOf(
      Array,
    );
  });
});
