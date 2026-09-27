import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_TOKEN, runIdentity, userAgent } from "./config.ts";
import { createLogger } from "./log.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runIdentity", () => {
  it("names GitHub Actions runs by run id and attempt", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_RUN_ID", "123456");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40));
    vi.stubEnv("GITHUB_EVENT_NAME", "schedule");
    expect(runIdentity(0)).toEqual({
      runId: "gh-123456-2",
      trigger: "schedule",
      codeVersion: "a".repeat(40),
    });
    vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
    expect(runIdentity(0).trigger).toBe("manual");
  });

  it("names local runs by their start time", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    expect(runIdentity(Date.UTC(2026, 8, 27, 3, 17))).toEqual({
      runId: "local-2026-09-27T03:17:00.000Z",
      trigger: "local",
      codeVersion: "dev",
    });
  });
});

describe("userAgent", () => {
  it("identifies the crawler, its version, and a contact URL", () => {
    expect(userAgent("0123456789abcdef0123456789abcdef01234567")).toBe(
      `${PRODUCT_TOKEN}/0123456 (+https://github.com/swarina/quarry)`,
    );
    expect(userAgent("dev")).toBe(`${PRODUCT_TOKEN}/dev (+https://github.com/swarina/quarry)`);
  });
});

describe("createLogger", () => {
  it("writes one JSON object per line with the level and component", () => {
    const lines: string[] = [];
    const log = createLogger(
      "pipeline",
      (line) => lines.push(line),
      () => 0,
    );
    log.warn("slow host", { host: "api.lever.co", duration_ms: 12 });
    expect(lines).toEqual([
      '{"ts":"1970-01-01T00:00:00.000Z","level":"warn","component":"pipeline","msg":"slow host","host":"api.lever.co","duration_ms":12}\n',
    ]);
  });
});
