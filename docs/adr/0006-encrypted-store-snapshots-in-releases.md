# ADR-0006: Keep the store as encrypted snapshots on a GitHub release

- Status: accepted
- Date: 2026-09-27
- From: #7, #8

## Context

The pipeline store is the system of record for crawl history, and it lives on ephemeral
GitHub Actions runners. Every run has to restore it at the start and save it at the end, or
the history is one day long forever.

The constraint is that this has to work on the free tier, with no database to pay for.
Release assets are the one durable, versioned, free place a workflow can write. They have an
uncomfortable property: if the repository becomes public, so do they. Quarry does not
republish full posting text, and the store holds exactly that.

There is also a correctness hazard specific to restoring. If a transient API failure makes
the restore look like "no snapshot exists", a run that starts from empty would crawl
everything, pack a one-day store, and commit it over the real history.

## Options

1. **A hosted database (D1, Turso, Postgres).** No pack and restore code, a dependency on a
   service, a cost beyond the free tier at this size, and the store is 832 MB.
2. **Actions cache.** Free and evicted on its own schedule, with no guarantee the entry is
   there tomorrow. Unacceptable for the system of record.
3. **Release assets, encrypted, with a manifest per snapshot.** Free and durable, and the
   publication and overwrite hazards have to be designed out.

## Decision

Option 3.

`store pack` writes a consistent copy with `VACUUM INTO`, checks it with
`PRAGMA integrity_check`, compresses with brotli (quality 5), and encrypts with AES-256-GCM
under `QUARRY_STORE_KEY`. The file header is authenticated, each snapshot records its own
sequence number inside the database, and a JSON manifest carries the sequence number, size,
and SHA-256.

`store pull` restores the newest snapshot and verifies the SHA-256, the GCM tag, SQLite's
integrity, and the embedded sequence number before anything appears at the destination. It
never overwrites an existing file. Starting from empty requires `--bootstrap`, which is
refused whenever a snapshot exists, so an API failure can never silently discard history.

Retention is 14 daily and 12 weekly snapshots. Writing is least privilege: the restoring code
only ever reads release assets, and uploads happen in a separate CI job that runs no
third-party code (ADR-0011). Because asset names are unique within a release and GitHub
answers 422 to a duplicate, uploading the next manifest acts as a compare-and-set, so two
runs can never both commit the same sequence number.

## Consequences

- Losing `QUARRY_STORE_KEY` loses the history. The key has to be kept in a password manager
  as well as in the repository secret, and that is documented in the README as a prerequisite
  to the first run.
- The unencrypted `VACUUM INTO` copy is made in a private temporary directory, never in the
  directory CI uploads, so an artifact step cannot publish plaintext by accident.
- Release assets whose upload never finished are ignored, and snapshots that never got a
  manifest are listed for pruning once they are a day old.
- Restoring 53 MB per run is a download on every run, which is well inside the free tier at
  this corpus size but scales linearly with the store.
- The compare-and-set on manifest names gives safety without a lock, at the cost of a run
  failing outright when it races, which is the correct outcome.
- Only the newest snapshot is proven by daily use, which is what ADR-0012 exists to cover.
