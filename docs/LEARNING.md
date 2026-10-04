# Learning journal

What each session taught, what was surprising, and what is still open. Newest first.

The entries are deliberately about the things that were not obvious beforehand. Anything that
went as expected belongs in a commit message, not here.

## 2026-10-04

### Jev and System One models

**A System One model returns values, not text, and that has consequences beyond the output
shape.** Checked against `@typesafe-ai/sdk` 0.6.0: the request is `{ state, questions, model }`
and the answer types carry `choice`, `score` or `noul` with `confidence` and `probabilities`.
There is no field pointing into the input and no parameter asking for one. Since nothing
generates a sentence, there is no place a quotation could arrive, so "answers point back to the
text" was never achievable through the API. That claim had been in the README since the first
commit (ADR-0026).

The useful realisation is that a typed answer can still carry a pointer without carrying text:
number a posting's paragraphs and make "which paragraph says this?" a choice question over the
numbers. The option limit is 255. Untested, and the kind of claim the accuracy harness exists to
check.

**Storing the whole distribution rather than the picked option is what makes a threshold mean
anything.** This one changed the design. With only the argmax and its confidence, "remote with
probability at least 0.7" can only be read as "the model picked remote, and was 70% sure". A
posting the model called hybrid at 40% with remote at 35% is dropped, although P(remote) = 0.35
is a fact we had and threw away. Keeping all of it turns every filter into one question,
regardless of answer kind: how likely is it that the answer is one of these options. A yes/no
answer expands to two options and a score to its levels, and the same code serves all three.

It cost 14 KB gzipped per full shard, against a 600 KB budget. Cheap enough that the earlier
instinct to store two numbers per question would have been a bad trade made for no reason.

**Probabilities published to two decimals mean hundredths are exact, not lossy.** The response
schema already relied on this to validate that a distribution sums to 1. Storing centi-
probabilities is therefore lossless, and normalizing them to sum to exactly 100 (largest
remainder) buys an invariant worth having: P(not these options) is exactly 100 minus theirs, so
the UI never shows a total of 99.

### Measurement

**Accuracy is too blunt to steer a probabilistic model by.** Being wrong while 95% sure and
wrong while 45% sure score identically on accuracy, and they are not the same failure. A proper
score (Brier) and expected calibration error separate them. Calibration error is the number that
actually licenses the product: filtering by probability only makes sense if an answer called 80%
likely is right about 80% of the time, and nothing had measured that.

**A test whose job is to catch a class of bug has to be verified against the bug.** Inherited
from #29, and it earned its place again: the golden harness built this session was checked both
ways against temporary fixtures, passing a model right as often as it claims and failing one
95% sure and right half the time. A harness that only ever sees good data is indistinguishable
from one that always passes.

**The site's confidence bands are still chosen by eye.** The threshold table the harness prints
(coverage against accuracy at each cut) is what should set them. The code says so where the
cuts are defined, so the next person does not read them as measured.

### Surprises

**Four store methods from the enrichment stage had no tests anywhere.** `saveAnswers`,
`unanswered`, `unansweredCount` and `recordEnrichment`: the rules deciding what gets paid for
were resting on one manual run of 30 postings. The PR body for #30 read as thoroughly tested,
and was, about everything else. Verified by grep, not by reading.

**Four referenced directories had never existed.** `docs/`, `docs/adr/` (cited by number from
five source comments), `notes/jev-notes.md` (cited four times from the question registry), and
`experiments/` (cited from the location golden test). Thirty merged pull requests had accumulated
references to files nobody had committed. Easy to produce and invisible without looking, since
nothing in CI checks that a path mentioned in a comment exists.

**FNV-1a is not a shuffle.** Its last operation is one multiply after the final byte, so ids
differing only at the end come out in the same order they went in. The store returns postings
sorted by id, so a "random sample" keyed on it was the first few by id. An avalanche step fixes
it. Found because a test asserted the sample was not simply store order, on ids chosen to differ
in one character.

**Counting a facet naively doubled the cost of queries that do not use it.** Answer facet
counting allocated an array per option per row, which took an unfiltered query over 100,000
postings from 42 to 96 ms p95. Reading the column directly brought it to 53 ms. The allocation
was in the obvious, readable version.

**A facet count excludes only its own filter, not all filters of its kind.** Got this wrong in a
test first and assumed the code was broken. Filtering on on-call should narrow the arrangement
counts, because arrangement has no filter in force, and the count is a promise about what
choosing an arrangement next would give.

### Open questions

- **Where the confidence bands cut.** Needs the labelled set.
- **Whether a model can point at the paragraph stating a fact** as reliably as it states the
  fact. Decides whether evidence is buildable at all.
- **Whether two listings is the right grace period** before a posting counts as closed. One
  listing hid live jobs for a day; two shows closed jobs for a day longer. No measurement yet of
  how often a listing is short.
- **What a novel custom question should cost a user**, and how to show a cost and coverage
  estimate before they run one. $3 and minutes of wall time over 35,000 postings is the thing
  the whole product hangs on, and it is unsolved.
- **Whether `NY` should be a city alias in a label where every other token is a city code.** A
  narrower rule than the one declined in ADR-0019, and it needs its own measurement.
- **Whether the 95% crawl-success threshold survives a larger seed list.** It is a judgement
  that has never been tested against a bad day.

### Still not true of this project

Nothing is deployed, so none of this is reachable by a person. The wedge, asking your own
questions, does not exist: the site filters standard answers, which is what every competitor
already does. Both are known, neither is started.
