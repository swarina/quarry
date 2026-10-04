# ADR-0020: Leave templates and test postings out of the index

- Status: accepted
- Date: 2026-09-28
- From: #22

## Context

Employers publish things on their job boards that are not jobs. Coupang's board had 19 postings
filed under a location called "z-Test & Templates Only", and Pleo one titled "EXTERNAL TEMPLATE
- Hybrid adverts". The index showed them as jobs in Seoul and elsewhere, and nobody can apply to
them.

The obvious filter is dangerous. Real jobs are about tests and templates: "Test Engineer",
"Test Automation Lead", "Template Technician". Real places sound like them too: Test Valley is a
borough in Hampshire. A keyword match on "test" or "template" would hide real jobs, which is a
worse error than showing a few fake ones.

## Options

1. **Leave them in.** Honest to the source, and the index shows jobs nobody can apply to, which
   is the single most irritating thing a job board does.
2. **Match "test" or "template" anywhere in the title or location.** Catches these and hides
   every Test Engineer in the corpus.
3. **A narrow rule, measured against the whole corpus.**

## Decision

Option 3. `isPlaceholder` requires one of:

- a title that **opens** with a template or test marker **set off by punctuation**, so "EXTERNAL
  TEMPLATE - Hybrid adverts" matches and "Test Engineer" does not;
- a title that says not to apply;
- a location label naming templates or a "z-test" bucket.

The store keeps placeholders as published, because they are what the employer published and the
observations should record it (ADR-0016). Only the index leaves them out, and its summary says
how many.

Measured across the 35,241 postings of the crawl at the time: the rule matched exactly the 20
postings above, and nothing else.

## Consequences

- The index does not show jobs nobody can apply to, which it did.
- The rule is narrow enough to be safe and therefore narrow enough to miss things. A template
  titled "Senior Engineer (do not use)" without the leading marker gets through. That is the
  intended direction of error: missing a placeholder costs one bad result, hiding a real job
  costs a candidate an opportunity.
- Keeping them in the store means the rule can be widened later and replayed, and that the count
  in each summary is a real signal: a jump means an employer started publishing differently.
- Checking the rule against the whole corpus rather than against the two examples is what makes
  "exactly these 20" a meaningful claim. A rule validated only on its motivating cases would
  have been the keyword match.
