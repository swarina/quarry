# Contributing

## Prerequisites

- Node.js 24 (see `.node-version`).
- pnpm, pinned in `package.json`. Either run `corepack enable` once, or prefix commands
  with `corepack` (for example `corepack pnpm install`).

## Setup

```sh
pnpm install
cp .env.example .env   # only needed for live Jev calls
pnpm check             # typography, lint, typecheck, and tests
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm check` | Everything CI runs, in order |
| `pnpm lint` | Biome lint, formatting, import order, and architecture rules |
| `pnpm format` | Apply Biome formatting and safe fixes |
| `pnpm typecheck` | TypeScript in strict mode |
| `pnpm test` | Vitest |
| `pnpm test:coverage` | Vitest with coverage thresholds (as CI runs it) |
| `pnpm check:text` | Rejects forbidden typography in tracked files |

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/domain` | Pure logic shared by every runtime. No third-party dependencies. |
| `packages/jev` | The only code that calls TypeSafe: pinned model, validated answers, spend limits, rate limiting, cost ledger, record and replay |
| `scripts` | Repository tooling |

Internal packages export TypeScript source directly; there is no build step.

## Architecture rules

These are enforced by Biome, so `pnpm lint` fails when one is broken:

- No import cycles.
- Every import is declared in the nearest `package.json`. Library code may not import
  development dependencies.
- Library code runs in Node.js and Cloudflare Workers. Node built-ins are only allowed
  under `src/node/`.
- Only `packages/jev` may import `@typesafe-ai/sdk`.
- Production code never imports test files.

## Conventions

- **TypeScript:**
  - Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  - No `any`: a suppression must carry a written reason.
  - Named exports only.
- **Validation:** validate at every boundary with zod (API responses, files, configuration).
- **Units:**
  - Money is integer nano-dollars.
  - Time is epoch milliseconds.
  - Durations carry their unit in the name (`timeoutMs`).
- **Tests:**
  - Tests sit next to the code as `*.test.ts`.
  - They are deterministic: clocks and timers are injected or faked, and there are no live network calls.
- **Commits:**
  - Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a
    package scope, for example `feat(jev): record API exchanges for replay`.
  - Keep each commit to one logical change.
- **Pull requests:**
  - All checks must pass.
  - Changes are squash-merged.
  - Every pull request states its resource impact.
- **Typography:** no em dashes anywhere; use commas, colons, parentheses, or separate sentences.
