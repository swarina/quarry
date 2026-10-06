# ADR-0027: Ask your own questions of the postings a search left

- Status: accepted
- Date: 2026-10-06

## Context

The wedge is that anyone can ask their own question of the market. The standard questions
(ADR-0024) are fixed, reviewed, and asked of everything once; a criterion is whatever someone
types, and it has to be answered while they wait.

The numbers decide the shape. Enrichment measured $0.000087 per posting for four questions, so
one new question over the whole corpus of 34,851 postings is about $3 and minutes of wall time.
That is cheap for a corpus and expensive for a click.

Two further problems come with letting outside text reach a paid API. The question is written by
a person, so it has to be checked before money is spent on it. And the posting text a model
reads lives only in the private store: the search index deliberately carries no descriptions,
and Quarry does not republish full posting text (ADR-0006), so the browser cannot send it.

## Options

**What a criterion is asked of:**

1. **The whole corpus, streamed.** The purest form of the wedge, and about $3 and minutes for
   every novel question, which forces a confirmation step before each one and a hard limit on
   who may trigger it.
2. **Only the postings the other filters leave.** A page of results, so a brand new question
   costs cents and answers in seconds. It is also how people search: narrow, then ask. The cost
   is that you cannot ask one question of the whole market in a single click; you ask it of a
   slice.
3. **A ranked sample, then widen.** Cheapest first answer, and presenting "what you have not
   seen yet" honestly is genuinely hard.

**Who may ask:** open to all with per-session quotas, or closed behind a secret.

## Decision

Option 2, closed behind a shared secret.

- **Only what the filters leave.** A request names up to 500 postings and is refused above that
  with a message pointing at filtering, because at that size it has not filtered. Measured on
  real postings at enrichment's rate, a full page of 500 is about $0.04.
- **Closed behind a secret**, compared without revealing where it differs through timing.
  Search stays public static files; only spending is closed. A public endpoint spending someone
  else's money needs per-IP quotas, a global cap and a cost confirmation, and that is a product
  to design once the cost model has been proven in real use, not a thing to guess at now.
- **The cache key is the wording.** A criterion's id is a hash of its normalized self, so two
  people asking the same thing in the same words share an answer and changing one word is a
  different question. This is ADR-0024's rule applied to text we did not write.
- **Work is keyed on text, not on postings**, so two postings with the same content hash are one
  request and both get the answer.
- **Two budgets.** A per-request cap keeps one search from being expensive by accident. A daily
  cap is a backstop against this code being wrong, which would be cheap per request and ruinous
  per day. Both are reserved before spending and settled afterwards, the shape ADR-0005 uses,
  because between a check and a charge other requests are in flight.
- **Untrusted text is checked before any request is built**, against Jev's own limits and
  through the same `assertValidQuestions` the client applies, so this cannot drift from the
  rules the request will be held to.
- **The handler is a plain `(Request) => Response`**, which is a Worker's own entry shape, with
  everything environment-shaped behind three ports: posting text, the answer cache, the daily
  budget. It lives in a package because `packages/*/src/**` is where Biome forbids Node
  built-ins (ADR-0001), which is the guarantee a Worker needs.

## Consequences

- A novel question is affordable enough to need no approval step, which is what makes the
  feature feel like search rather than like a job submission.
- The cache compounds on popular filter and question pairs: the second person to ask pays
  nothing, and the pipeline's own enrichment is unaffected.
- You cannot ask one question of the whole market in one click. That is a real loss against the
  pitch, and the honest mitigation is that the corpus-wide version already exists as
  `pipeline enrich` for questions worth adding to the standard set.
- The secret means the feature is not shareable. Anyone Quarry is shown to can search but not
  ask, until the public design exists.
- Posting text has to be served to this path and to nothing else, which is why it is a port
  rather than a file. A deployment implements it over D1 or R2; getting that wrong would
  republish the text the project promises not to.
- The ask loop starts requests from an estimate, so it is not itself the cap. The exact cap is
  the client's spend limit, set per request to the allowance. Anything that builds a client
  without one has a budget that leaks, which is worth remembering when the Worker is written.
- 500 postings and 5 criteria per request are judgements, not measurements. The first real use
  should check whether a page of results is the unit people actually want.
