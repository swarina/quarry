import { describe, expect, it } from "vitest";
import { BOARD_GONE_AFTER_NOT_FOUND, BOARD_GONE_MIN_SPAN_MS, isBoardGone } from "./board.ts";

describe("isBoardGone", () => {
  const start = 1_790_000_000_000;

  it("needs both enough 404s and enough time", () => {
    const later = start + BOARD_GONE_MIN_SPAN_MS;
    expect(isBoardGone(BOARD_GONE_AFTER_NOT_FOUND, start, later)).toBe(true);
    expect(isBoardGone(BOARD_GONE_AFTER_NOT_FOUND - 1, start, later)).toBe(false);
    expect(isBoardGone(BOARD_GONE_AFTER_NOT_FOUND + 5, start, later - 1)).toBe(false);
  });
});
