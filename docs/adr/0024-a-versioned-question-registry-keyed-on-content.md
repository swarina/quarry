# ADR-0024: A wording is the question, and answers are keyed on content

- Status: accepted
- Date: 2026-10-04
- From: #30

## Context

Enrichment asks Jev a fixed set of questions about every posting. Two things about that need
deciding before any answer is stored, because both are expensive to change afterwards.

**What identifies a question.** Jev reads a question literally. "What work arrangement does this
posting offer?" and "Where is this work done?" are different questions, and their answers are
not interchangeable, even though a person would call them the same question. If the registry
identified a question by its id alone, editing a wording would silently change what every
stored answer means, and a cache would serve answers to a question nobody asked.

**What identifies a posting, for caching.** A posting is crawled daily and usually unchanged.
Paying again for an unchanged posting is pure waste at $0.000087 each across 35,000 postings;
serving a stale answer for an edited one is wrong.

## Options

For question identity: id only, or id plus a version of the wording.

For caching: key on the posting id, which is stable and wrong after an edit; key on the content
hash, which is exactly what changed; or key on the crawl, which never reuses anything.

## Decision

A wording **is** the question. `@quarry/questions` holds each question with a version, answers
are stored under the version that produced them, and rewording means a new version, under which
every posting is unanswered again. The alternative, quietly reinterpreting old answers, is the
kind of error that produces a plausible wrong product for months.

Answers are keyed on the **content hash**, not the posting. ADR-0003 already defines content as
the fields that make up a posting's text, excluding links, dates, and markup, so an ATS template
change does not count as an edit. From that key, three behaviours follow without any further
rule:

- an edited posting is asked again;
- an unchanged posting is never paid for twice;
- a repost with identical text is free, and two postings with identical text share one answer.

## Consequences

- Rewording a question costs a full re-run: $3.03 for the current corpus. That is the honest
  price of knowing what an answer means, and it makes rewording a deliberate decision rather
  than an edit.
- The v1 wordings are drafts from the Phase 0 experiments. They are explicitly the user's to
  refine, and refining them is a version bump, not a patch.
- Everything downstream has to carry the version. The index records which wording produced the
  answers in each shard (ADR-0007), the build name changes when a wording changes, and the
  sampling for the accuracy harness takes only answers under the current wordings.
- Keying on content means an answer's lifetime is the text's lifetime. A posting edited daily is
  paid for daily, which is correct and could become a cost if some ATS rewrites text on every
  fetch. The content hash excluding markup and dates is what keeps that from happening by
  accident.
- A content-keyed cache is shared across postings and across users, which is what makes the
  custom-question path affordable later: the same question about the same text is answered once
  for everybody.
