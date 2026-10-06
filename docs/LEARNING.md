# Learning journal

What each session taught, what was surprising, and what is still open. Newest first.

The entries are deliberately about the things that were not obvious beforehand. Anything that
went as expected belongs in a commit message, not here.

## 2026-10-06 (later)

### Putting the question box on the site

**The content security policy had already made the decision.** The site has sent
`connect-src 'self'` since it was built, which means the page can call back to the host it came
from and nowhere else. So "same origin or a CORS policy?" was not really open: a cross-origin
criterion path could not have been reached from the page without weakening a header that is
correct. The choice had been made months earlier by someone writing a sensible default, and the
work was to notice rather than to decide (ADR-0028).

**Not importing the package was the load-bearing choice again.** The obvious move is for the site
to import `@quarry/criteria` for its types. That package reaches `@quarry/jev` and through it the
SDK, and the site pays for every byte. So the wire shapes are declared a second time in
`criteria.ts`, which is a real cost: two declarations can drift, and the drift would appear as
somebody's first click failing. The test file closes it by driving the page's own requests into a
real handler, which is a better guard than the import would have been, because it checks the
behaviour rather than the shape. The same reasoning produced INDEX_FORMAT 4 carrying its own
questions; it is becoming the house pattern for anything the browser needs to know about the
model layer.

**The posting cap turned out to do two jobs.** It exists because the server refuses more than 500
(ADR-0027). It also happens to be what makes narrowing by a criterion answer exact: below the cap
one query returns every matching row, so filtering those rows is filtering the whole result and
not just the page on screen. Above it the feature would have had to either lie about its counts
or paginate answers it does not hold. The constraint that looked like a limitation is what made
the filter honest.

### Surprises

**A criterion answer should be shown even when the model is unsure, unlike a standard one.** The
site hides a standard answer whose own best guess lands in the "unlikely" band, because a spread
distribution is not a fact about the job and there are three other questions speaking. For a
question somebody just typed and paid for, silence reads as "not asked" when the truth is "the
model does not know", and those are the two things the whole design keeps apart. So the tag stays
and says "unsure" instead.

**`pkill -f` caught my own shell for the second time in two sessions.** Same pattern, same exit
144, same cause: the pattern matches the command line running it. Killing by pid from `pgrep`
does not help either, because the substitution is still in the shell's own command line. The
lesson that actually works is to match on something only the server has, like its arguments.

### Open questions

- **Whether the question box belongs beside the filters at all.** It sits above the results as
  another control, which makes it look like a filter, and it is the only thing on the page that
  spends money. Nobody has used it yet.
- **Whether a reload losing the answers is annoying in practice.** It is cheap to recover, since
  the server caches on the wording, but cheap is not the same as unnoticed.

## 2026-10-06

### The criterion path

**A Cloudflare Worker's entry point is the Web-standard `fetch` handler, which made the
deployment blocker much smaller than it looked.** The whole request path is a plain
`(Request) => Response` function, testable in Node with no Cloudflare anything. Only two things
are genuinely Cloudflare-shaped: the deploy configuration, and the storage bindings, which went
behind three ports (posting text, the answer cache, the daily budget). That turned "blocked on
network access to the docs" into "one adapter left to write".

**Putting it in a package rather than an app was the load-bearing choice.** `packages/*/src/**`
is where Biome forbids `node:*` imports (ADR-0001), and `apps/**` is not. A Worker needs exactly
that guarantee, so the lint rule enforces portability instead of me remembering it. The Node-only
adapters sit under `src/node/`, where the rule exempts them by design.

**Asking only what the filters leave is what makes the wedge affordable.** A page of 500 real
postings is about $0.04 against $3.03 for the whole corpus. That is the difference between a
feature that needs a confirmation dialogue and one that feels like search. It also matches how
people actually search: narrow, then ask.

### Surprises

**Two postings with the same text were being asked twice.** The first version queued work per
posting; a repost with identical content hash therefore paid twice, and the estimate priced it
twice. ADR-0024 already said a repost is free, so the test was right and the code was wrong.
Keying the work on text rather than on postings fixed both.

**A refused spend looked like a broken source.** `BUDGET_EXCEEDED` was counted as a consecutive
posting failure, so five of them made a run report `stoppedBy: "errors"`. That is exactly the
confusion the stop reason exists to prevent (ADR-0025), and it would have sent a reader hunting
for a fault that was not there. A refusal is now neither counted nor allowed to trip the failure
stop. The underlying cause was `stoppedBy` being last-writer-wins across concurrent workers; it
resolves by precedence now, with the budget winning because it is the constraint a reader can
act on.

**The ask loop cannot be the budget cap, and saying so in the type was the fix.** It decides how
many requests to start from an estimate, but learns a request's cost only when it returns. The
exact cap has to be the client's spend limit, reserved and settled (ADR-0005). A test that
asserted the loop itself never overshoots was asserting something false; it now pins the real
bound (the requests in flight) and a separate test drives a real spend limit against a transport
that would happily charge far more.

**`openPostings` could not serve the criterion path**, because it omits descriptions on purpose
to keep memory small. Loading all 35,000 descriptions to answer about fifty would have been the
wrong fix; resolving each id prefix as an indexed range scan on the primary key was the right
one.

**`pkill -f serve-criteria` killed my own shell**, because the pattern matched the command line
running it. Worth remembering when backgrounding a dev server by name.

### Open questions

- **Whether a page of results is the unit people want to ask about.** 500 postings and 5 criteria
  per request are judgements, not measurements, and the first real use should check them.
- **What the public version looks like.** The path is closed behind a secret, so the feature is
  not shareable. Opening it needs per-IP quotas, a global cap and a visible cost estimate, and
  that is a product to design once the cost model has been seen in real use.
- **Whether the criterion id should include the model.** It does not; the cache key does. That
  keeps a criterion's identity stable across a model upgrade while correctly invalidating its
  answers, but it means two different things are called "the criterion" in different places.

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
