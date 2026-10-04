# ADR-0001: Enforce the architecture rules in the linter, not in review

- Status: accepted
- Date: 2026-09-26
- From: `68350f4`, `0d7e9f8`

## Context

Quarry runs the same logic in three places: Node.js in the pipeline, Cloudflare Workers in
the API, and the browser in the site. Several of its invariants are the kind that review
catches only when a reviewer happens to remember them:

- portable library code must not reach for Node.js built-ins, or it cannot run on a Worker
  or in a browser;
- exactly one package may call the TypeSafe SDK, so model pinning, spend limits, rate
  limiting, and the cost ledger cannot be bypassed by importing the SDK directly;
- import cycles between packages make the dependency layering a fiction;
- a package may only import what it declares, or installs are not reproducible.

A fourth concern is supply chain: a freshly published version of a dependency is the window
in which a compromised release is live but not yet reported.

## Options

1. **Write the rules down in CONTRIBUTING and trust review.** Free, and loses to a tired
   reviewer on a Friday. The single-Jev-entry-point rule in particular is invisible in a
   diff that merely adds an import.
2. **Enforce them with Biome rules scoped by path.** Costs some configuration, and every
   violation becomes a failed check with a named rule instead of an opinion.
3. **Split into separate repositories per runtime.** Makes the boundaries physical, at the
   price of cross-repository changes for every shared type.

## Decision

Option 2. A pnpm workspace with strict TypeScript, Biome for formatting and linting, and
Vitest with coverage thresholds. Biome carries the architecture rules as path-scoped
configuration: no import cycles, no undeclared dependencies, no Node.js built-ins outside
`packages/*/src/node/**`, and the TypeSafe SDK importable only from `packages/jev/src`.

Two further checks ride along: installs refuse any package version published less than three
days ago (`minimumReleaseAge`), and `scripts/check-text.ts` rejects em dashes in every
tracked text file. CI runs the typography check, Biome, the typecheck, and the test suite
with coverage thresholds on every push and pull request, with third-party actions pinned to
commit SHAs, a read-only workflow token, and checkout that does not persist credentials.

## Consequences

- A violation of a structural rule fails CI with the rule's name, so the conversation is
  about the design and not about whether the rule exists.
- The rules live in `biome.json`, which means the configuration is long and has to be read
  as part of the architecture. The path scopes are the layering diagram.
- `minimumReleaseAge` delays legitimate upgrades by three days. Dependabot is configured to
  wait the same three days so its pull requests do not arrive unmergeable.
- Any genuinely portable use of a Node.js built-in has to move into a `src/node` entry
  point, which is the intended pressure.
