# ADR-0008: Record and replay API exchanges instead of mocking the SDK

- Status: accepted
- Date: 2026-09-26
- From: `8784a62`

## Context

Every test that touches Jev has to decide what stands in for the API. The constraints are
unusual: requests cost money, answers are probabilistic rather than fixed, and the analyses that
set thresholds need to be re-runnable without paying again each time.

A mock of the SDK's interface tests our code against our belief about the API, which is exactly
the thing most likely to be wrong about a model launched weeks ago.

## Options

1. **Mock `@typesafe-ai/sdk`.** Fast and offline, and it encodes assumptions rather than
   checking them. A response shape we guessed wrong passes forever.
2. **Hit the live API in tests.** Real, and slow, flaky, and billed, with answers that can
   change between runs so assertions have to be loose.
3. **Record real exchanges once, then replay them.** Real responses, deterministic tests, no
   repeat cost, at the price of a transport layer and stored fixtures.

## Decision

Option 3. `createCassetteFetch` is a fetch-compatible transport with three modes: `live`,
`record` (replay a stored exchange when one matches, otherwise call the API and store the
result), and `replay` (never touch the network).

- Exchanges are keyed by method, path, and the canonical request body, which includes the
  model, and never by headers. Credentials are therefore neither stored nor part of the key.
- Only successful responses are recorded, so a transient failure is not baked into a fixture.
- A replay miss surfaces as a `CASSETTE_MISS` `JevError` rather than being retried, because
  silently falling through to the network is how a test starts costing money.
- The Node entry point adds a file-backed store that writes each exchange atomically.

## Consequences

- Tests run against responses the API actually sent, so a wrong assumption about the shape
  fails once, loudly, at recording time.
- Analyses are repeatable. Re-running the threshold work over a recorded set costs nothing,
  which is what made the accuracy harness (ADR-0005's sibling, `scoreQuestion`) affordable to
  iterate on.
- Keying on the canonical body means ADR-0002's serialization is load bearing here too: two
  equal requests must produce identical bytes or every replay misses.
- Fixtures go stale. A recorded exchange is a snapshot of a model's behaviour at a date, and
  nothing automatically notices when the live API diverges. Re-recording is a deliberate act.
- Recording requires a key and spends money, so the first run of any new analysis is not free,
  only the rest.
