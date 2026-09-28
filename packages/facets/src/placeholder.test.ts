import { describe, expect, it } from "vitest";
import { isPlaceholder } from "./placeholder.ts";

const posting = (title: string, locations: readonly string[] = ["Berlin"]) => ({
  title,
  locations,
});

describe("isPlaceholder", () => {
  it.each([
    posting("EXTERNAL TEMPLATE - Hybrid adverts"),
    posting("Template: Software Engineer"),
    posting("[TEMPLATE] Account Executive"),
    posting("Test posting - please ignore"),
    posting("Internal tooling engineer (do not apply)"),
    posting("Staff, Data Scientist (Ads Analytics)", ["z-Test & Templates Only"]),
    posting("Director, Back-end Engineering", ["Seoul, South Korea; z-Test & Templates Only"]),
    posting("Account Manager", ["Templates"]),
  ])("finds a template or test: $title in $locations", (candidate) => {
    expect(isPlaceholder(candidate)).toBe(true);
  });

  it.each([
    posting("Test Engineer"),
    posting("Senior QA Test Lead"),
    posting("Template Technician"),
    posting("Test Automation Engineer - Payments"),
    posting("Software Engineer, Testing Infrastructure"),
    posting("Planning Officer", ["Andover, Test Valley"]),
    posting("Field Sales Representative", ["Testour, Tunisia"]),
    posting("Email Template Developer"),
  ])("keeps a real job: $title in $locations", (candidate) => {
    expect(isPlaceholder(candidate)).toBe(false);
  });
});
