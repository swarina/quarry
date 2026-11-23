# The standard questions' accuracy set

`golden.test.ts` scores the standard questions against postings answered by a person. Three
files here hold the set. The sheet is sampled and waiting; the labels are the part only a person
can write.

| File | What it is | State |
| --- | --- | --- |
| `answers-golden.csv` | The sheet: 150 postings, one column per question, to fill in by hand | Sampled, no labels yet |
| `answers-labelling.md` | What every option means, written for whoever fills the sheet in | Ready |
| `answers-predictions.json` | What the model already said about those same 150 postings | Ready |

Until each question has 30 labels, the score for that question is reported as skipped rather
than passed, and no accuracy figure is claimed anywhere.

## Filling the sheet in

1. Open `answers-golden.csv` in a spreadsheet or an editor. Each row carries the posting's
   company, title, and URL.
2. Open the URL, read the posting, and write the option id for each of the four questions:
   `arrangement`, `seniority`, `sponsorship`, `onCall`. `answers-labelling.md` lists every option
   id and what it means, which is the same wording the model was given.
3. Leave a cell empty when the posting genuinely does not say. Those are counted and excluded
   rather than held against the model. The `notes` column is free text, for anything that was a
   close call.
4. Do not read `answers-predictions.json` first. A label that agrees because it was suggested
   measures nothing, which is why the model's answers are in a separate file.

30 labels for a question is the fewest that says anything; 150 rows is what the sheet holds.
Partial work is safe to commit: an unlabelled or part labelled sheet skips rather than failing,
and a question crosses into being scored on its own as its labels arrive.

## Scoring it

```sh
pnpm vitest run packages/questions/src/golden.test.ts
```

A failure prints the whole report for the question that moved, with the postings where the model
and the labels disagree, worst first. To check the state without running the suite:

```sh
pnpm --filter @quarry/questions report-golden-set
```

## Then

Set the floors in `golden.test.ts` from what was measured, below the measured score so one
posting moving does not fail a build. Raise them when the questions improve; lowering one means a
label in the set is wrong, not that the model may be.

Read each floor against the `majorityShare` the report prints, which is what always answering the
commonest label would score. One option dominates both `sponsorship` and `onCall` in this corpus,
so a floor below about 90% for either cannot fail a model that learned nothing. The floors
committed today are placeholders and two of them have exactly that problem.

The numbers that matter most are the calibration error and the threshold table. The site groups
answers into likely, maybe, and unlikely, and the cuts between them were chosen by eye; the
threshold table is what should set them.

Once every question is labelled, add `QUARRY_REQUIRE_GOLDEN: 1` to the test step in
`.github/workflows/ci.yml`, so that from then on a set going missing fails the build instead of
being reported.

## Sampling it again

The pair was taken from a fully answered store, and costs nothing to retake because enrichment
has already paid for the answers:

```sh
pnpm pipeline sample-answers --store <store> --out packages/questions/fixtures --size 150
```

Retaking it discards the labels, because a different store samples different postings. Only do
it when the questions themselves change, which `golden.test.ts` detects: it fails when the sheet
has no column for a question, or when the recorded questions no longer match the ones being
asked.

The sample is uniform over fully answered postings, not stratified by option. That is the right
shape for overall accuracy and for calibration, both of which need the mix of postings the
product actually serves. It does mean the rarer options are thinly covered: in this sample the
model answers `not_mentioned` for sponsorship on 138 of the 150 rows, and `no` for on call on
141. Per-option behaviour needs a second sample drawn from the long tail, scored separately and
weighted, which is what the location set does with its `stratum` column.
