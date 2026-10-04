# ADR-0012: Drill the oldest snapshot, and probe for a schedule that stopped

- Status: accepted
- Date: 2026-09-28
- From: #13

## Context

The daily pipeline restores the newest snapshot on every run, so that path is exercised
constantly. Everything else about the backup is untested in practice:

- the older snapshots retention keeps, which are what you reach for after damage nobody noticed
  for a week;
- the oldest one, which is furthest behind the current schema and so most likely to fail
  migration;
- whether a restored store can actually be resumed from, as opposed to merely opened.

There is a second gap of the same shape. A workflow cannot report that it failed to run. If the
schedule stops firing, the failure issue is never opened, because nothing opened it.

## Options

1. **Trust it.** The newest snapshot is proven daily, and the backup nobody has restored is the
   one that does not work.
2. **Restore by hand occasionally.** Works until the person forgets, which is the normal case.
3. **A scheduled drill, plus an external probe.** Costs Actions minutes and some workflow, and
   turns both gaps into alerts.

## Decision

Option 3.

The drill runs monthly (14:37 UTC on the 2nd) and on demand, and:

1. restores the **oldest** snapshot retention keeps onto a fresh runner, which is both the
   fallback after unnoticed damage and the one furthest behind the schema;
2. checks integrity, and checks the store actually holds crawl history rather than merely
   opening;
3. **resumes from it**: opening migrates it to the current schema, then five boards are crawled
   using its ETags and presence data;
4. checks it again.

It commits nothing. A failed scheduled drill opens a `restore-drill` issue, which the next
successful drill closes, matching the pipeline's own alerting (ADR-0011).

`probe.yml` checks daily that a snapshot was committed in the last 30 hours. It is a separate
workflow precisely so that it does not depend on the pipeline having run.

`store pull --snapshot newest|oldest|<n>` exists so that a drill, and a rollback, need no
hand-written script. `--bootstrap` still works only when the release holds no snapshot at all.

## Consequences

- The restore path that matters in a disaster is exercised every month, including the migration
  from the oldest schema in retention.
- Resuming from the restored store is the part that catches the subtle failures: a store can
  pass an integrity check and still be useless if its ETags or presence data do not line up.
- About 2 to 3 Actions minutes a month, which is nothing against the budget in ADR-0011.
- The drill cannot run until a snapshot exists, so it is one of the steps that only starts
  working after the first bootstrap run.
- A monthly drill means up to a month of not knowing. Weekly would narrow that and cost more;
  monthly is the starting point, not a conclusion.
