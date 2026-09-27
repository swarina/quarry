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
