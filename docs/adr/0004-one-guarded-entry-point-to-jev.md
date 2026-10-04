# ADR-0004: Pin the model and validate every answer

- Status: accepted
- Date: 2026-09-26
- From: `ddb1984`, `a4129a0`

## Context

Jev returns typed answers with calibrated probabilities. Two properties of the product
depend on which model produced an answer: the answer cache, which is keyed partly on model
version, and any threshold a user has tuned ("show me the ones above 0.8"). A calibration
curve belongs to a model, so an answer from a different model is not a cheaper version of
the same answer, it is a different answer.

Model aliases such as `jev-latest` move without notice. If the SDK silently followed one, a
cache populated over months would hold answers from several models under keys that claim one,
and every tuned threshold would drift.

Separately, the SDK does not validate responses at runtime, and Jev enforces a per-account
request rate that many parallel calls would trip.

## Options

1. **Call the SDK wherever a model answer is needed.** Simplest, and every call site becomes
   a place where pinning, validation, and rate limiting can be forgotten.
2. **A thin wrapper that only adds the rate limiter.** Covers the limit that produces loud
   failures and leaves the quiet ones (a moved alias, an unvalidated response) in place.
3. **One guarded entry point that every caller must use, enforced by the linter.** Costs an
   indirection and makes the guarantees structural.

## Decision

Option 3. `createJevClient` wraps `@typesafe-ai/sdk` behind the single interface the rest of
the codebase uses, and ADR-0001's Biome rule makes `packages/jev/src` the only place allowed
to import the SDK.

- Every request is pinned to `jev-1.13.0`. A response from any other model is rejected
  rather than cached.
- Questions are checked against the documented limits before any money is spent.
- Every response is validated against a schema derived from the questions that were asked.
- SDK failures map to a `JevError` with a stable code and a retryable flag.

The rate limiter bounds concurrency and uses a token bucket that holds at most one second of
requests, so bursts stay small and sustained traffic settles at the configured rate. Waiters
are served in arrival order, an aborted caller gives up its place in the queue, and bucket
arithmetic uses integer credits so waits are exact. The clock and sleep are injectable, which
is what makes the tests deterministic.

## Consequences

- Upgrading the model is a deliberate, reviewable change in one place, and it invalidates the
  cached answers that were produced by the old model. That is the honest cost of calibrated
  output, not an accident to work around.
- A schema mismatch fails loudly at the boundary instead of flowing into the store as a
  plausible-looking answer.
- Every caller inherits rate limiting whether or not it thought about it, which is the point.
- The wrapper has to track the SDK's error surface. When the SDK changes its failure modes,
  the mapping to `JevError` is the thing that needs revisiting.
