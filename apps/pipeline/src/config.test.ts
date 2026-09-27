import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  PRODUCT_TOKEN,
  runIdentity,
  storeKey,
  storeSettings,
  userAgent,
} from "./config.ts";
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

describe("storeSettings", () => {
  it("reads the repository, a token, and the store key", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "swarina/quarry");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "token");
    vi.stubEnv("QUARRY_STORE_KEY", "key");
    expect(storeSettings()).toEqual({ repository: "swarina/quarry", token: "token", key: "key" });
  });

  it("lists what is missing", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "not a repository");
    vi.stubEnv("QUARRY_STORE_KEY", "");
    expect(() => storeSettings()).toThrow(ConfigError);
    expect(() => storeSettings()).toThrow(/GITHUB_REPOSITORY[\s\S]*QUARRY_STORE_KEY/);
    vi.stubEnv("GITHUB_REPOSITORY", "swarina/quarry");
    vi.stubEnv("QUARRY_STORE_KEY", "key");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    expect(() => storeSettings()).toThrow(/GITHUB_TOKEN or GH_TOKEN/);
  });

  it("requires the key for packing", () => {
    vi.stubEnv("QUARRY_STORE_KEY", "");
    expect(() => storeKey()).toThrow(/QUARRY_STORE_KEY must be set/);
    vi.stubEnv("QUARRY_STORE_KEY", "abc");
    expect(storeKey()).toBe("abc");
  });
});
