# ADR-0018: Make politeness impossible for a caller to forget

- Status: accepted
- Date: 2026-09-27
- From: #4
- Cited from: `packages/crawl/src/fetcher.ts`

## Context

Quarry crawls job board APIs that employers publish for embedding. Those APIs are not ours, the
companies behind them have not agreed to anything, and the whole project depends on not being a
nuisance: a crawler that hammers a host gets blocked, and deservedly.

Politeness is a long list of small obligations: read robots.txt first, respect `Crawl-delay`,
leave a gap between requests to the same host, back off on 429, honour `Retry-After`, stop
hitting a host that keeps failing, send conditional requests so an unchanged board costs almost
nothing. Each one is easy to write and easy to forget, and forgetting any of them is invisible
in a code review of the call site.

## Options

1. **Document the rules and have callers follow them.** No code, and every new call site is a
   chance to miss one. The crawler is the only caller today, but "today" is how this kind of
   rule decays.
2. **A helper callers may use.** Better, and still optional, which means it is optional.
3. **One client that cannot be bypassed, with politeness inside it.** Callers get it whether or
   not they thought about it, at the cost of a less flexible interface.

## Decision

Option 3. `@quarry/crawl` is the only way the crawler makes an HTTP request, and every
obligation lives inside it:

- **robots.txt per RFC 9309**, fetched once per host before any other request. Groups naming
  our product token win over `*`, the longest match wins with `allow` winning ties, `*` and `$`
  patterns use a linear-time matcher rather than a regex that could backtrack, and
  `Crawl-delay` is honoured. A 4xx means no rules; a 5xx, 429, or network failure skips the host
  for the run, because an unreadable robots.txt is not permission.
- **Pacing:** one request at a time per host with a gap of at least a second (or the site's
  crawl delay) after each response. Hosts run in parallel, so politeness costs wall time per
  host, not overall.
- **Retries:** at most two, for 429, 408, 5xx, timeouts, and network errors, with exponential
  backoff and full jitter. `Retry-After` is honoured up to five minutes; longer fails the
  request rather than blocking the host.
- **A circuit breaker:** after five consecutive host-level failures the host pauses for five
  minutes, and the next request goes out as a probe. A 404 counts as a healthy host.
- **Conditional requests:** a stored ETag goes out as `If-None-Match`, and a 304 comes back as
  `not-modified`.
- **Limits:** a timeout covering the body as well as the headers, a maximum response size, and a
  maximum crawl delay of 60 seconds, beyond which the host is skipped rather than allowed to
  stall the run.

Encoding is normalised before matching, so `%7E` and `~` compare equal as RFC 9309 requires.

## Consequences

- No call site can be impolite, which is the point. The interface is narrower than `fetch` and
  that is a feature.
- Two findings came from running it rather than reading it, and both are in the code now:
  - The breaker originally skipped a failing host for the rest of the run. A full crawl of 251
    boards hit a 50-second local network outage and lost 92 boards for the day. Pausing and
    probing instead was the fix.
  - `fetch` adds `Cache-Control: no-cache` to conditional requests, as the Fetch standard
    specifies, and Lever's API then never answers 304. Sending `Cache-Control: max-age=0`
    explicitly restores revalidation, which is most of the crawl's bandwidth.
- Boards skipped by robots.txt count as failures in the run summary, so the success rate cannot
  look better than it is.
- Network errors keep their cause, so a failure reads as `fetch failed: getaddrinfo ENOTFOUND`
  rather than as a bare failure.
- The politeness is only as good as the product token we send and the robots.txt we read. If a
  site states its terms somewhere else, this code will not know.
