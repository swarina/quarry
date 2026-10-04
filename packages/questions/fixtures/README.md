# The standard questions' accuracy set

`golden.test.ts` scores the standard questions against postings answered by a person. Two files
belong here, and neither is in the repository yet, so that test skips:

| File | What it is |
| --- | --- |
| `answers-golden.csv` | The labels: one row per posting, one column per question, filled in by hand |
| `answers-predictions.json` | What the model said about those postings, and the questions it was asked |

## Producing them

```sh
pnpm --filter @quarry/pipeline exec node src/main.ts sample-answers \
  --store <store> --out packages/questions/fixtures --size 150
```

It spends nothing and needs no key: `pipeline enrich` has already paid for these answers and the
store kept them, so this reads what the product actually serves rather than asking again.

Three files come out. `answers-labelling.md` says what each option means, and is a working note
rather than something to commit. The sheet starts with every question column empty.

## Filling the sheet in

Open each posting's URL, read it, and write the option id you judge correct. Leave a cell empty
when the posting genuinely does not say: those are excluded from the score rather than counted
against the model.

Do not read `answers-predictions.json` first. A label that agrees because it was suggested
measures nothing, which is why the predictions are a separate file.

## Then

Set the floors in `golden.test.ts` below what was measured, so one posting moving does not fail a
build. Raise them when the questions improve. Lowering one means a label in the set is wrong, not
that the model may be.

The numbers that matter most are the calibration error and the threshold table. The site groups
answers into likely, maybe, and unlikely, and the cuts between them were chosen by eye; the
threshold table is what should set them.
