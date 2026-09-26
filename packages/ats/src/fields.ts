import type { PayInterval, SalaryRange } from "@quarry/domain";
import { z } from "zod";

/** http and https links only; anything else in a URL field is a schema problem. */
export const httpUrl = z.url({ protocol: /^https?$/ });

/** Collapses whitespace and trims; returns null for strings with no content. */
export function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

/** Cleaned, non-empty, first occurrence kept. */
export function cleanList(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned !== null) seen.add(cleaned);
  }
  return [...seen];
}

/** Epoch milliseconds for an ISO 8601 timestamp, or null when it doesn't parse. */
export function parseTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** An ISO 3166-1 alpha-2 code in uppercase, or null. */
export function countryCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * A salary range, or null when the currency or interval is unknown or neither bound is a
 * non-negative number.
 */
export function salaryRange(
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string | null | undefined,
  interval: PayInterval | undefined,
): SalaryRange | null {
  const code = currency?.trim().toUpperCase() ?? "";
  const low = typeof min === "number" && Number.isFinite(min) && min >= 0 ? min : null;
  const high = typeof max === "number" && Number.isFinite(max) && max >= 0 ? max : null;
  if (!/^[A-Z]{3}$/.test(code) || interval === undefined || (low === null && high === null)) {
    return null;
  }
  return { min: low, max: high, currency: code, interval };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
