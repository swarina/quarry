import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AtsSource, htmlToText, isAtsSource, postingContentHash } from "@quarry/domain";
import { describe, expect, it } from "vitest";
import { listingRequest, parseListing } from "./adapters.ts";

/**
 * Contract tests against real listing responses recorded by `scripts/record-fixtures.ts`.
 * They check that today's API shapes still map cleanly, not specific content, so re-recording
 * the fixtures should not require changing these tests.
 */
const FIXTURES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");

interface Fixture {
  readonly source: AtsSource;
  readonly slug: string;
  readonly url: string;
  readonly recordedAt: string;
  readonly body: unknown;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as Fixture;
      if (!isAtsSource(fixture.source)) throw new Error(`${name}: unknown source`);
      return fixture;
    });
}

const fixtures = loadFixtures();

describe("recorded listings", () => {
  it("cover every ATS", () => {
    expect(new Set(fixtures.map((fixture) => fixture.source))).toEqual(
      new Set(["greenhouse", "lever", "ashby"]),
    );
  });

  describe.each(fixtures.map((fixture) => [`${fixture.source}/${fixture.slug}`, fixture] as const))(
    "%s",
    (_, fixture) => {
      it("was recorded from the URL the adapter requests", () => {
        expect(fixture.url).toBe(listingRequest(fixture.source, fixture.slug).url);
      });

      it("maps every job to a usable posting", async () => {
        const listing = parseListing(fixture.source, fixture.body);
        expect(listing.items.length).toBeGreaterThan(0);
        expect(listing.duplicates).toBe(0);
        for (const item of listing.items) {
          if (item.kind === "invalid") throw new Error(`${item.externalId}: ${item.problem}`);
          const { posting } = item;
          expect(posting.externalId).toBe(item.externalId);
          expect(posting.title.length).toBeGreaterThan(0);
          expect(posting.url).toMatch(/^https:\/\//);
          expect(posting.locations.length).toBeGreaterThan(0);
          expect(htmlToText(posting.descriptionHtml).length).toBeGreaterThan(100);
          expect(htmlToText(posting.descriptionHtml)).not.toMatch(/<\/?(p|div|li|ul|br)\b/i);
          expect(await postingContentHash(posting)).toMatch(/^[0-9a-f]{64}$/);
        }
      });
    },
  );
});
