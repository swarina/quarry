# ADR-0030: Publish no per-posting pages, and enter no job-posting programme

- Status: accepted
- Date: 2026-11-26
- From: #74

## Context

The site carries no per-posting pages. #74 raised that as a discovery problem with a specific
opportunity attached: Google runs a job-posting surface in Search, fed by `JobPosting`
structured data, and the index already holds most of the fields it wants. Measured on build
`6bda5a367637`, over 35,201 postings:

| Field | Coverage |
| --- | --- |
| `title`, `hiringOrganization`, `jobLocation` | every posting |
| `datePosted` | 35,201 (100%) |
| `employmentType` | 13,445 (38.2%) |
| `baseSalary` | 4,984 (14.2%) |
| `description` | stored in `posting_contents`, not in the index |

The cheap half of #74 shipped without needing a decision: metadata, `robots.txt`, and a sitemap
holding the one URL this site has. This record is about the other half, which was deliberately
left open because the obstacle turned out not to be the one the issue assumed.

#74 framed it as a cost question: 36,656 rendered pages, a crawl budget conversation, and a
build step. Two corrections to that framing, both of which change the answer.

**The page count is 35,201, not 36,656.** 36,656 is the row count across shards, and a posting
that names several continents is a row in each of them (ADR-0007). Pages would be per posting,
so the smaller number is the real surface. This makes the cost case *better*, which is worth
stating before rejecting it on other grounds.

**The requirements are not negotiable in the way a build cost is.** Google's `JobPosting`
documentation, read on 2026-11-26, requires `datePosted`, `description`, `hiringOrganization`,
`jobLocation` and `title`. Three of its rules decide this record:

1. `description` is required, must be "the full description of the job in HTML format", and
   must be a complete representation of the job: responsibilities, qualifications, skills,
   hours, education and experience.
2. "The structured data must appear on the same page as the job description that job seekers
   can read in their browser." So the description cannot live in markup alone, invisible to
   visitors. There is no markup-only variant of this.
3. A posting no longer open must be expired, by a past `validThrough`, a 404 or 410, or the
   removal of the markup. "Failure to take timely action on expired jobs may result in a
   manual action."

Rule 1 and rule 2 together mean entry into this programme is the act of publishing employers'
job descriptions on our own domain, visibly. `README.md` and the page footer both say Quarry
"never copies a description"; it reads the public board APIs companies expose for embedding and
links to the employer's own page to apply. That sentence is not incidental, and it is the only
thing that makes reading 499 sources defensible without a conversation with each of them.

So this is not a cost question with a cheaper variant hiding in it. It is a question about what
Quarry is, and the answer is already written down in two places.

Rule 3 adds a cost that a static site is badly shaped for. The daily pipeline would have to
make a closed posting's URL return 404 or 410, reliably, every day, with a manual action as the
penalty for drift. ADR-0012 exists because schedules stop silently; here a stopped schedule
would become a Search penalty rather than a stale index.

## Options

1. **Per-posting pages for the whole corpus, with `JobPosting` markup.** 35,201 pages, which
   is a tractable build. Requires publishing every description, reversing a stated commitment,
   and taking on a daily expiry obligation backed by a manual action.
2. **Per-posting pages for a recent subset.** A smaller crawl surface for the same commitment
   reversal, and a *harder* expiry problem rather than an easier one, because the subset churns
   by definition: every page leaving the window has to be expired correctly.
3. **Per-posting pages carrying no description.** Not eligible for the programme, since
   `description` is required and must be visible. What this produces is 35,201 thin pages,
   duplicating data already on the employer's own page, with none of the benefit. It would also
   be the worst thing for the crawl budget of the one page that does work.
4. **Decline. Keep one page, and no job-posting markup.** Organic discovery stays whatever a
   single well-described page earns. The commitment stands.

## Decision

Option 4. Quarry publishes no per-posting pages and enters no job-posting programme.

The reason is not the build cost, which is modest, nor the crawl surface, which could be
managed. It is that the programme's required fields make publishing employers' descriptions the
entry fee, and Quarry's stated position, in the README and on the page itself, is that it does
not do that. Reversing that is a product and licensing decision about becoming a publisher of
descriptions rather than a search surface over links. It is not a decision to arrive at
sideways, as a consequence of wanting better search placement.

Option 3 is recorded explicitly because it is the tempting compromise and it is strictly worse
than doing nothing: all of the crawl cost, none of the eligibility.

## Consequences

- Organic discovery rests on one page. #74's judgement that this is close to fatal for a job
  search product stands, and this record accepts it rather than answering it. Whatever reach
  Quarry gets will come from being linked to and from shared searches, which the URL-state
  design (ADR-0023) at least makes possible.
- Nothing further is owed to the sitemap. It holds one URL because there is one page, and this
  record is why that will not change.
- No daily expiry obligation, and no exposure to a manual action if the pipeline stalls.
- The "never copies a description" sentence keeps its force. It is now load bearing for a
  decision, not only a description of current behaviour, which is a reason to be careful about
  editing it casually.
- What would make us revisit this: a decision to publish descriptions, taken on its own terms
  and with the licensing question answered for the boards Quarry reads. If that decision is
  ever taken, this record should be superseded rather than quietly worked around, and the
  revisit should also check something not verified here: whether the ATS-hosted employer pages
  Quarry links to already carry `JobPosting` markup themselves, in which case Quarry's copies
  would be competing duplicates of pages that are already in the programme.
- Also unresolved, and smaller: the index is enough to populate every required field except
  `description`. That is worth remembering, because it means the blocker is exactly one field,
  and it is the one field that is not ours to republish.
