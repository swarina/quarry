# ADR-0011: Split the daily run into a read-only job and a writing job

- Status: accepted
- Date: 2026-09-27
- From: #8, #11

## Context

The crawl runs daily on GitHub Actions and has to write the store snapshot somewhere durable
(ADR-0006: a release asset). Writing a release asset needs a token with `contents: write`.

The crawl job is also the job that runs the most code: our own, plus every production
dependency, against responses from 499 third-party hosts. Giving that job a write token means a
compromised dependency or a malicious response has a credential that can rewrite the
repository's releases, and with them the store's whole history.

## Options

1. **One job with a write token.** Simplest, and the blast radius is the repository.
2. **One job with a read token, and commit the snapshot some other way.** There is no other way
   on the free tier.
3. **Two jobs: the crawl read-only, a separate job with the write token that runs no
   third-party code.** More workflow to maintain, and the credential is only ever held by a job
   whose entire body is the `gh` CLI.

## Decision

Option 3.

- **Crawl job**: read-only token, production dependencies only. Restores the store, crawls, and
  packs the snapshot even when the crawl failed, because progress is committed per board
  (ADR-0010). The snapshot goes to the next job as a one-day artifact. The job fails if fewer
  than 95% of boards were crawled successfully.
- **Commit job**: write token, checks out nothing, runs only `gh`. Uploads the snapshot, then
  its manifest. Manifest names are unique per sequence number, so a second writer fails rather
  than overwriting history.
- **Report job**: a failed scheduled run opens or updates a `pipeline-failure` issue, and the
  next successful run closes it. Failed manual runs raise no alerts, because a human is already
  watching.
- **`probe.yml`** checks daily that a snapshot was committed in the last 30 hours, which catches
  a schedule that stopped firing, and manages a `pipeline-stale` issue the same way. A workflow
  cannot report that it never ran, so something outside it has to.
- Runs never overlap. Third-party actions are pinned to commit SHAs, user inputs reach scripts
  through environment variables rather than interpolation, and the crawl job's checkout does not
  persist credentials.
- **`--dry-run`** crawls every board into a throwaway store and saves nothing: no restore, no
  snapshot, no commit, no alerts, and no store key needed. It exists so a change to seeds or
  adapters can be checked from GitHub's runners before it touches real data.

## Consequences

- The credential that can rewrite history is held only by a job that runs no code we did not
  write, for a few seconds.
- The split is why the snapshot survives a failed crawl: the commit job depends on the packed
  output, not on the crawl job's result.
- Two jobs mean an artifact handoff, which is a step that can fail on its own. It is a one-day
  artifact, so a stuck handoff loses a day rather than the history.
- The 95% threshold is a judgement. Too low and a bad day passes unnoticed; too high and a
  handful of dead boards fails every run. It needs revisiting as the seed list grows.
- About 12 Actions minutes a day, within the 2,000 a month included for private repositories.
  That budget is the reason the crawl is once daily rather than hourly.
