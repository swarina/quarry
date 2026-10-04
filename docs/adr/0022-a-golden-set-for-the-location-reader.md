# ADR-0022: Hold the reader to hand-labelled answers, with floors below today

- Status: accepted
- Date: 2026-10-04
- From: #29

## Context

ADR-0015's reader reports that it places 99% of postings. That number says it produced an
answer, not that the answer was right, and the difference is where the real bugs live. The bug
that prompted this work placed a posting labelled "Karkiv" in fifteen countries: the reader
produced an answer for every one of them.

Unit tests pin individual labels, which catches regressions in the cases someone thought of. It
cannot say whether accuracy overall is going up or down, and it cannot stop a scoring retune
from trading twenty labels for one.

## Options

1. **Keep adding unit tests.** Cheap and measures nothing in aggregate.
2. **Assert an accuracy number.** Measures the right thing and fails whenever one label moves,
   which trains everyone to raise the number rather than look.
3. **A hand-labelled set with floors below the current score, printing what disagreed.**

## Decision

Option 3. 150 real labels, sampled from the corpus rather than invented: 100 weighted by how
often a label shape occurs and 50 from the long tail, each with the posting context the reader
actually sees, answered by hand.

The floors sit **below** today's score, so one label moving does not fail a build, and a failure
prints which labels disagree rather than only that a number dropped. Raising a floor is free
when the reader improves. **Lowering one means a label in the set is wrong, not that the reader
may be**, which is the rule that keeps the set from eroding.

Five labels are pinned to their exact reading rather than to containing the right country. That
distinction is the point: the "Karkiv" bug returned the right country buried among fourteen
wrong ones, so a containment check passed it. The first version of this test did exactly that
and caught nothing, which was found by deleting the fix and watching the test still pass.

Two rows carry an open question rather than a settled answer, and are counted as disagreements
until decided: "Southern Europe", which the reader expands to all of Europe, and "Manhattan, New
York", which it reads as Manhattan rather than New York City.

Today: countries exactly right on 100% of the common labels and 98% of the tail, cities on
95.6%, every named country found.

## Consequences

- Accuracy is measured rather than asserted, and a change that makes the reader worse fails with
  the labels that moved.
- Verifying the test by deleting the fix is the step that made it worth having, and is worth
  repeating for any test whose job is to catch a specific class of bug. A test that passes
  whether or not the bug is present measures nothing, and looks exactly like one that works.
- 150 labels is a sample. Per-stratum accuracy on 50 tail labels has wide error bars, and the
  floors are set loosely for that reason.
- Labels are judgements. Recording the two unsettled rows as disagreements rather than picking
  an answer keeps them visible instead of baking a coin flip into the baseline.
- This is the pattern the standard questions' accuracy harness follows. The difference is that
  labels there need the model's answers recorded alongside, since there is no deterministic
  function to re-run.
