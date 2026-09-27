/**
 * The job board APIs Quarry reads. `lever-eu` is Lever's EU instance, which has its own host
 * and its own set of companies.
 */
export const ATS_SOURCES = ["greenhouse", "lever", "lever-eu", "ashby"] as const;

export type AtsSource = (typeof ATS_SOURCES)[number];

export function isAtsSource(value: string): value is AtsSource {
  return (ATS_SOURCES as readonly string[]).includes(value);
}
