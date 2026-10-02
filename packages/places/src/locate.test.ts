import type { NormalizedPosting } from "@quarry/domain";
import { describe, expect, it } from "vitest";
import { gazetteer } from "./gazetteer.ts";
import { locatePosting, type PostingLocation } from "./locate.ts";

const cityNames = new Map(gazetteer().cities.map((city) => [city.id, city.name]));

type Located = Pick<NormalizedPosting, "locations" | "places" | "country" | "workplace">;

function locate(posting: Partial<Located>, home: string | null = null) {
  return locatePosting(
    { locations: [], places: [], country: null, workplace: null, ...posting },
    home,
  );
}

function where(location: PostingLocation): string[] {
  return location.places.map((place) =>
    [place.country, place.division, place.city === null ? null : cityNames.get(place.city)]
      .filter((part) => part !== null)
      .join("/"),
  );
}

describe("locatePosting", () => {
  it("places a posting by its labels, without repeats", () => {
    const location = locate({ locations: ["London, UK", "London", "Paris; London"] });
    expect(where(location)).toEqual(["GB/ENG/London", "FR/11/Paris"]);
    expect(location).toMatchObject({
      basis: "labels",
      workplace: null,
      anywhere: false,
      unplaced: [],
    });
  });

  it("reads labels with the structured places as hints", () => {
    // Lever states the country; an office or address names it too.
    expect(where(locate({ locations: ["Georgia"], country: "US" }))).toEqual(["US/GA"]);
    expect(
      where(
        locate({
          locations: ["London"],
          places: [{ label: null, text: "London, Ontario, Canada" }],
        }),
      ),
    ).toEqual(["CA/08/London"]);
  });

  it("takes the address the ATS pairs with a label that names no place", () => {
    const location = locate({
      locations: ["Remote", "New York"],
      places: [{ label: "Remote", text: "Austin, Texas, United States" }],
    });
    expect(where(location)).toEqual(["US/TX/Austin", "US/NY/New York City"]);
    expect(location.workplace).toBe("remote");
  });

  it("falls back to structured places when no label names one", () => {
    const offices = locate({
      locations: ["Hybrid"],
      places: [{ label: null, text: "Berlin, Germany" }],
    });
    expect(where(offices)).toEqual(["DE/16/Berlin"]);
    expect(offices).toMatchObject({ basis: "structured", workplace: "hybrid" });

    const country = locate({ locations: ["Remote"], country: "DE" });
    expect(where(country)).toEqual(["DE"]);
    expect(country.basis).toBe("structured");

    const nowhere = locate({ locations: ["Home based - Worldwide"] });
    expect(nowhere).toMatchObject({
      places: [],
      basis: "none",
      workplace: "remote",
      anywhere: true,
    });
  });

  it("prefers remote, then hybrid, then on-site, when labels differ", () => {
    expect(locate({ locations: ["Berlin (Hybrid)", "Remote - Germany"] }).workplace).toBe("remote");
    expect(locate({ locations: ["Office Based - Berlin", "Hybrid"] }).workplace).toBe("hybrid");
    expect(locate({ locations: ["Office Based - Berlin"] }).workplace).toBe("onsite");
  });

  it("reports labels that name neither a place nor an arrangement", () => {
    expect(locate({ locations: ["Jobs.cz", "Remote", "Prague"] }).unplaced).toEqual(["Jobs.cz"]);
  });

  it("takes the office that says a label again when the label itself names no place", () => {
    // A misspelt city the gazetteer cannot read, with the company's offices listed beside it.
    const offices = ["Paris, France", "Lviv, Ukraine", "Karkiv, Ukraine", "Malta"].map((text) => ({
      label: null,
      text,
    }));
    const found = locate({ locations: ["Karkiv"], places: offices });
    expect(where(found)).toEqual(["UA"]);
    expect(found.basis).toBe("labels");
  });

  it("still falls back to every office when no office says the label", () => {
    const offices = ["Paris, France", "Lviv, Ukraine"].map((text) => ({ label: null, text }));
    const remote = locate({ locations: ["Remote"], places: offices });
    expect(where(remote)).toEqual(["FR/11/Paris", "UA/15/Lviv"]);
    expect(remote.basis).toBe("structured");
    // Too short to match by accident: "US" must not pick the office that merely contains it.
    const short = locate({ locations: ["USX"], places: [{ label: null, text: "Austin, US" }] });
    expect(short.basis).toBe("structured");
  });

  it("does not match an arrangement word against the words of an office", () => {
    // "Remote" is an arrangement, not a place, so it must not pick out the remote offices.
    const offices = ["Remote - United States", "Berlin, Germany"].map((text) => ({
      label: null,
      text,
    }));
    const found = locate({ locations: ["Remote"], places: offices });
    expect(where(found)).toEqual(["US", "DE/16/Berlin"]);
    expect(found).toMatchObject({ basis: "structured", workplace: "remote" });
  });

  it.each([
    [{ locations: ["Hybrid"], places: [{ label: null, text: "Hybrid" }] }, "JP"],
    [{ locations: ["In-Office"] }, "JP"],
    [{ locations: ["Headquarters"] }, "JP"],
    [{ locations: ["Corporate Headquarters"] }, "JP"],
    [{ locations: ["HQ", "Hybrid"] }, "JP"],
    // The arrangement the ATS states counts, when no label says one.
    [{ locations: [], workplace: "onsite" as const }, "JP"],
  ])("puts a hybrid, on-site, or headquarters job nothing places at home: %j", (posting, home) => {
    const location = locate(posting, home);
    expect(where(location)).toEqual([home]);
    expect(location.basis).toBe("home");
  });

  it.each([
    // Remote jobs can be anywhere, whatever else the posting says.
    { locations: ["Remote"] },
    { locations: ["Hybrid or Remote"] },
    { locations: ["Hybrid"], workplace: "remote" as const },
    { locations: ["Headquarters"], places: [{ label: null, text: "Remote" }] },
    // Something we can't read may name the place.
    { locations: ["In-Office"], places: [{ label: null, text: "APJC" }] },
    { locations: ["Hybrid", "Parloa Inc."] },
    { locations: ["Hybrid", "Multiple locations"] },
    { locations: ["Hybrid"], places: [{ label: null, text: "Multiple locations" }] },
    // Nothing says where the job is done.
    { locations: ["Multiple locations"] },
    { locations: [] },
    { locations: ["Home based - Worldwide"] },
  ])("leaves a posting unplaced rather than guess: %j", (posting) => {
    expect(locate(posting, "JP")).toMatchObject({ places: [], basis: "none" });
  });

  it("puts nothing at home when a label, a field, or an unknown home settles it", () => {
    expect(where(locate({ locations: ["Hybrid - Osaka"] }, "US"))).toEqual(["JP/32/Osaka"]);
    expect(locate({ locations: ["Hybrid"], country: "DE" }, "US").basis).toBe("structured");
    expect(locate({ locations: ["Hybrid"] }, null)).toMatchObject({ places: [], basis: "none" });
  });
});
