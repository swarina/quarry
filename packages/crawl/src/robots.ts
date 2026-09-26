/**
 * robots.txt parsing and matching per RFC 9309, plus the widely used `Crawl-delay` extension.
 *
 * - Groups start with one or more `user-agent` lines. Every group naming our product token is
 *   used (merged); only when none does are the `*` groups used.
 * - The longest matching rule wins, and `allow` wins a tie. `*` matches any characters and a
 *   trailing `$` anchors the end. No matching rule means allowed, and `/robots.txt` is always
 *   allowed.
 */
export interface RobotsPolicy {
  isAllowed(pathAndQuery: string): boolean;
  /** Seconds between requests the site asks for, if any. */
  readonly crawlDelaySeconds: number | undefined;
}

/** RFC 9309 asks crawlers to parse at least 500 KiB; anything past this limit is ignored. */
export const ROBOTS_MAX_BYTES = 512 * 1024;

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
}

interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
  crawlDelaySeconds: number | undefined;
}

export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true, crawlDelaySeconds: undefined };
export const DISALLOW_ALL: RobotsPolicy = {
  isAllowed: (path) => path === "/robots.txt",
  crawlDelaySeconds: undefined,
};

export function parseRobots(text: string, productToken: string): RobotsPolicy {
  const groups = parseGroups(text.slice(0, ROBOTS_MAX_BYTES));
  const token = productToken.toLowerCase();
  let selected = groups.filter((group) => group.agents.includes(token));
  if (selected.length === 0) selected = groups.filter((group) => group.agents.includes("*"));

  const rules = selected.flatMap((group) => group.rules);
  const delays = selected
    .map((group) => group.crawlDelaySeconds)
    .filter((delay): delay is number => delay !== undefined);

  return {
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : undefined,
    isAllowed(pathAndQuery) {
      if (pathAndQuery === "/robots.txt") return true;
      const path = normalizeEncoding(pathAndQuery);
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!matches(rule.pattern, path)) continue;
        if (
          best === undefined ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: undefined };
        groups.push(current);
      }
      current.agents.push(agentToken(value));
      lastWasAgent = true;
      continue;
    }
    // Only group members end a run of user-agent lines; other records (Sitemap) don't.
    if (key !== "allow" && key !== "disallow" && key !== "crawl-delay") continue;
    lastWasAgent = false;
    if (current === undefined) continue;
    if (key === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    } else if (value.length > 0) {
      current.rules.push({ allow: key === "allow", pattern: normalizeEncoding(value) });
    }
  }
  return groups;
}

/** `QuarryBot/1.0` names the product token `quarrybot`; `*` stays `*`. */
function agentToken(value: string): string {
  if (value.startsWith("*")) return "*";
  return (/^[A-Za-z_-]+/.exec(value)?.[0] ?? value).toLowerCase();
}

/**
 * Percent-encodes non-ASCII characters and uppercases existing escapes, so a pattern and a URL
 * path compare octet for octet as the RFC requires.
 */
function normalizeEncoding(value: string): string {
  return value
    .replace(/%[0-9a-f]{2}/gi, (sequence) => sequence.toUpperCase())
    .replace(/[^\p{ASCII}]+/gu, (text) => encodeURIComponent(text));
}

/**
 * Whether `path` starts with a match of `pattern`, where `*` matches any run of characters and
 * a trailing `$` requires the match to reach the end. Greedy with single backtracking, so it
 * runs in O(pattern x path) at worst, with no regex backtracking blowups.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < path.length) {
    const char = glob.charAt(p);
    if (p < glob.length && char !== "*" && char === path.charAt(s)) {
      p += 1;
      s += 1;
    } else if (p < glob.length && char === "*") {
      star = p;
      p += 1;
      resume = s;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      s = resume;
    } else {
      return false;
    }
  }
  while (glob.charAt(p) === "*") p += 1;
  return p === glob.length;
}
