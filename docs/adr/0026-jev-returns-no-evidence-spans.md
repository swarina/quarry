# ADR-0026: Jev returns no evidence spans, so stop promising them

- Status: accepted
- Date: 2026-10-04

## Context

The README has claimed since the first commit:

> **Evidence, not generated claims.** Answers point back to the text of the posting.

Nothing implements it, and before designing anything the first question is whether the model
can do it at all. Checked against `@typesafe-ai/sdk` 0.6.0, the version ADR-0004 pins:

- `SystemOneRequest` is `{ state, questions, model? }`. There is no parameter that asks for
  evidence, spans, quotes, or an explanation.
- The three answer types carry nothing of the kind. `NoulResponse` is `{ type, noul }`,
  `ChoiceResponse` is `{ type, choice, confidence, probabilities }`, and `ScoreResponse` adds
  `score` and `legend`. No field points into the input.
- The strings "evidence", "span", "citation", "quote", "excerpt" and "highlight" appear nowhere
  in the SDK's types, its README, or its compiled source.

That is the whole surface: a System One model returns typed values with probabilities, not
text, so there is no generated sentence in which a quotation could arrive. The docs at
docs.typesafe.ai could not be read from this environment to confirm it a second way, so this
rests on the SDK that is actually installed and called, which is the surface the code depends
on either way.

## Options

1. **Keep the claim and implement it later.** Free today, and the README is making a promise
   the product cannot keep, on the one axis (trust) where being caught out is most expensive.
   This is a portfolio project, and a reviewer who checks is the audience.
2. **Drop the claim entirely.** Honest and loses something real: pointing at the text is a
   genuine differentiator, and the idea is sound even if this one mechanism is unavailable.
3. **Correct the claim to what is true now, and record how evidence could be built.** Honest
   today, and keeps the design question open with the finding attached.

## Decision

Option 3. The README now says what the product actually offers: answers are typed and
calibrated, the posting's own text is a click away, and a model produced the answer rather than
the employer stating it. The word "evidence" is not used for something that does not exist.

How it could be built, recorded here so the measurement is not redone: Jev's typed questions
can carry a pointer without carrying text. Split a posting into paragraphs, number them, and
ask one extra choice question per criterion whose options are the paragraph numbers ("which
part of the posting states where the work is done?"). `JEV_LIMITS.maxChoiceOptions` is 255,
which is more paragraphs than a posting has, and an extra question in an existing request costs
a few tokens because the posting's text is already being sent and is the expensive part
(ADR-0025). The answer is a paragraph number with a probability, which the site can highlight
in the text it already links to.

That is a design to propose and cost properly, not to slip in. It changes the question
registry, so it changes what every stored answer means (ADR-0024).

## Consequences

- The README no longer claims a capability the model does not have.
- Any future evidence work starts from a measurement rather than from the assumption that the
  API will hand it over.
- Should a later Jev version return spans, this record is the thing to revisit: the pinned
  model is a deliberate choice, so gaining the feature means a model upgrade and the cache
  invalidation that comes with it.
- The paragraph-pointer sketch is untested. It assumes a System One model can pick the
  paragraph that states a fact as reliably as it can state the fact, which is exactly the kind
  of claim the accuracy harness exists to check, and it should be measured before being built.
