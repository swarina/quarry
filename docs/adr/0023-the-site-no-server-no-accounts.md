# ADR-0023: No server and no accounts, with the search in the URL

- Status: accepted
- Date: 2026-10-01
- From: #27

## Context

ADR-0007 put the index in the browser, which leaves the site with nothing it needs a server
for: no query endpoint, no session, no database. That makes a set of choices available that are
usually unavailable, and worth taking deliberately rather than by default.

There is also a specific constraint from the data. Everything in the index was written by an
employer: titles, company names, location labels. It goes into the page, and treating any of it
as markup would be an injection vector with 499 sources.

## Options

1. **Accounts and saved searches on a server.** Familiar, and needs a database, a session store,
   and somewhere to be liable for personal data, for a product whose searching does not need
   any of it.
2. **No accounts, state in `localStorage`.** No server, and a search cannot be shared or
   reopened elsewhere, and the back button does nothing.
3. **No accounts, state in the URL.**

## Decision

Option 3. Every search is in the URL and nowhere else, which makes it shareable and makes the
back button work. There is no account and nothing is stored about a visitor.

- **How far down the list you are is deliberately left out.** It is where you are, not what you
  asked for, so sharing a link gives the other person the search rather than your scrolling.
- **The region is always in the URL**, even when it is the one this browser would have chosen.
  Without it a shared link means "wherever you are", and a search for jobs in Germany opens
  almost empty for someone whose browser starts on another continent. This was a real bug found
  by building the page.
- **Everything an employer wrote goes into the page as text, never as markup.**
- The local server sends the headers the deployment will, including a content security policy
  with no inline scripts, so what is checked locally behaves like production.
- **Plain TypeScript bundled by esbuild**, the only new dependency: 23 KB of script, 8 KB
  gzipped at the time.
- One continent's shards load, chosen from the browser's own time zone, plus the postings open
  to anywhere, which match any place filter: about 300 KB for Europe rather than the 1.1 MB the
  whole index weighs. Apply links follow once results are on screen, so they never delay a first
  result.
- Accessibility was built in rather than retrofitted: a skip link, a search landmark, labelled
  controls, live regions, visible focus, and no reliance on colour alone.

## Consequences

- Nothing to run, nothing to pay per user, and no personal data to be responsible for.
- No saved searches and no alerts, which are real features this gives up. Both would need an
  account, and both can be added as a separate thing later without changing how searching works.
- A long search makes a long URL. Filters are coded compactly for that reason, and the answer
  criteria added later follow the same shape.
- Choosing the region from the time zone is a guess that is wrong for anyone searching outside
  their own continent, which is why it is a visible, changeable control rather than a silent
  default.
- `bench.html` answers an exit criterion that needed a real browser: every region at once, the
  queries the page sends, 8.9 ms at the 95th percentile over 34,831 postings against a 100 ms
  budget, on an M-series Mac.
- Building the page caught two bugs that had passed their own tests: the shared-link region, and
  a country facet that promised fewer postings than clicking it showed. Both were in code with
  tests, and only using it surfaced them.
