import type { RunTrigger } from "@quarry/storage/node";
import { z } from "zod";

/** Identifies the crawler in robots.txt groups and in every request's User-Agent. */
export const PRODUCT_TOKEN = "QuarryBot";
const CONTACT_URL = "https://github.com/swarina/quarry";

export interface RunIdentity {
  readonly runId: string;
  readonly trigger: RunTrigger;
  readonly codeVersion: string;
}

const environment = z.object({
  GITHUB_ACTIONS: z.string().optional(),
  GITHUB_RUN_ID: z.string().regex(/^\d+$/).optional(),
  GITHUB_RUN_ATTEMPT: z.string().regex(/^\d+$/).optional(),
  GITHUB_SHA: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  GITHUB_EVENT_NAME: z.string().optional(),
});

/**
 * Who this run is: on GitHub Actions, `gh-<run id>-<attempt>` with the commit it runs; anywhere
 * else, a local run named by its start time. This module is the only one that reads
 * `process.env`.
 */
export function runIdentity(startedAt: number): RunIdentity {
  const env = environment.parse(process.env);
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_RUN_ID !== undefined) {
    return {
      runId: `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`,
      trigger: env.GITHUB_EVENT_NAME === "schedule" ? "schedule" : "manual",
      codeVersion: env.GITHUB_SHA ?? "unknown",
    };
  }
  return {
    runId: `local-${new Date(startedAt).toISOString()}`,
    trigger: "local",
    codeVersion: "dev",
  };
}

export function userAgent(codeVersion: string): string {
  const version = /^[0-9a-f]{40}$/.test(codeVersion) ? codeVersion.slice(0, 7) : codeVersion;
  return `${PRODUCT_TOKEN}/${version} (+${CONTACT_URL})`;
}

/** Missing or malformed environment variables; the message lists every problem. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface StoreSettings {
  /** `owner/name` of the repository whose release holds the snapshots. */
  readonly repository: string;
  readonly token: string;
  /** Base64 AES-256 key for snapshot encryption. */
  readonly key: string;
}

/** GitHub Actions passes a secret that doesn't exist as an empty string. */
function present(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Settings for restoring snapshots from the repository's release. */
export function storeSettings(): StoreSettings {
  const repository = present("GITHUB_REPOSITORY");
  const token = present("GITHUB_TOKEN") ?? present("GH_TOKEN");
  const key = present("QUARRY_STORE_KEY");
  const problems = [
    repository === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repository)
      ? "GITHUB_REPOSITORY must be set to owner/name"
      : undefined,
    token === undefined ? "GITHUB_TOKEN or GH_TOKEN must be set" : undefined,
    key === undefined ? "QUARRY_STORE_KEY must be set to decrypt and encrypt snapshots" : undefined,
  ].filter((problem) => problem !== undefined);
  if (repository === undefined || token === undefined || key === undefined || problems.length > 0) {
    throw new ConfigError(`Environment:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  return { repository, token, key };
}

/** The snapshot encryption key alone, for packing. */
export function storeKey(): string {
  const key = present("QUARRY_STORE_KEY");
  if (key === undefined) {
    throw new ConfigError("Environment:\n- QUARRY_STORE_KEY must be set to encrypt snapshots");
  }
  return key;
}
