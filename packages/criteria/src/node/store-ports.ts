import type { PipelineStore } from "@quarry/storage/node";
import type { BudgetStore } from "../budget.ts";
import type { AnswerCache, PostingSource, PostingText } from "../ports.ts";

/**
 * The ports, backed by the pipeline store.
 *
 * Node-only, which is why it lives under `src/node/`: it reads SQLite. A deployment would
 * implement the same three ports over D1 or R2 instead, and nothing else about the request path
 * would change.
 */

/**
 * Posting text from the store.
 *
 * The store is the only place the descriptions exist: the search index deliberately carries
 * none, and Quarry does not republish full posting text (ADR-0006). Prefixes are resolved in
 * SQL, one indexed range scan each, rather than by holding every description in memory: a
 * request asks about a page of results, so loading 35,000 descriptions to answer about 50 would
 * be both wasteful and unnecessary.
 */
export function createStorePostingSource(store: PipelineStore): PostingSource {
  return {
    read(idPrefixes) {
      return Promise.resolve(
        store.postingTexts(idPrefixes).map(
          (row): PostingText => ({
            id: row.id,
            contentHash: row.contentHash,
            title: row.title,
            company: row.company,
            locations: row.locations,
            description: row.description,
          }),
        ),
      );
    },
  };
}

/** The answer cache, backed by the store, so answers survive a restart. */
export function createStoreAnswerCache(
  store: PipelineStore,
  now: () => number = Date.now,
): AnswerCache {
  return {
    read(criterionId, model, contentHashes) {
      return Promise.resolve(store.criterionAnswers(criterionId, model, contentHashes));
    },
    write(criterionId, model, answers) {
      store.saveCriterionAnswers(criterionId, model, now(), answers);
      return Promise.resolve();
    },
  };
}

/**
 * The daily budget, backed by the store.
 *
 * Persisted because the cap guards against this code being wrong, and a cap that resets when
 * the process restarts guards against nothing: a crash loop would spend all day.
 */
export function createStoreBudgetStore(store: PipelineStore): BudgetStore {
  return {
    reserve(day, wanted, perDayNanoUsd) {
      return Promise.resolve(store.reserveCriterionSpend(day, wanted, perDayNanoUsd));
    },
    release(day, unspent) {
      store.releaseCriterionSpend(day, unspent);
      return Promise.resolve();
    },
    committed(day) {
      return Promise.resolve(store.committedCriterionSpend(day));
    },
  };
}
