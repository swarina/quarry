/**
 * What asking a criterion needs from the world around it, and nothing more.
 *
 * These exist so the handler can be written and tested without a deployment. Everything
 * Cloudflare-shaped lives behind one of them, which keeps the part that cannot be built yet
 * (the D1 or R2 adapters) small and named, rather than spread through the request path.
 */

/** A posting as a criterion is asked about it: identity, and the text the model reads. */
export interface PostingText {
  /** The full posting id. */
  readonly id: string;
  /**
   * Hash of the content the text came from. The cache is keyed on it, not on the posting
   * (ADR-0024), so an edited posting is asked again and an unchanged one is never paid for
   * twice.
   */
  readonly contentHash: string;
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  /** The description as plain text, which is what the model is given. */
  readonly description: string;
}

/**
 * Where posting text comes from.
 *
 * The browser cannot send it: the search index deliberately carries no descriptions, and the
 * store that has them is a private snapshot. So the text has to be served, and it has to be
 * served to this path only. Quarry does not republish full posting text (ADR-0006), which is
 * why this is a port and not a public file.
 *
 * Postings are named by the id prefix the index uses, because that is what a browser has.
 */
export interface PostingSource {
  /**
   * Resolves id prefixes to postings. A prefix that matches nothing, or more than one posting,
   * is left out of the result rather than guessed at: answering about the wrong job is worse
   * than answering about fewer.
   */
  read(idPrefixes: readonly string[]): Promise<readonly PostingText[]>;
}

/** One cached answer, as the model gave it. */
export interface CachedAnswer {
  readonly contentHash: string;
  /** The model's own JSON, read through the facets layer and never trusted as a bare value. */
  readonly answerJson: string;
}

/**
 * Answers already paid for.
 *
 * Keyed by criterion, model, and content hash. The model is part of the key because a
 * calibrated answer belongs to the model that produced it (ADR-0004), so an upgrade must not
 * serve old answers as new ones.
 *
 * This is what makes the wedge affordable: the same question about the same text is answered
 * once for everybody, forever.
 */
export interface AnswerCache {
  read(
    criterionId: string,
    model: string,
    contentHashes: readonly string[],
  ): Promise<readonly CachedAnswer[]>;
  write(criterionId: string, model: string, answers: readonly CachedAnswer[]): Promise<void>;
}

/** A source holding postings in memory, for tests and for a local run. */
export function createMemoryPostingSource(postings: readonly PostingText[]): PostingSource {
  return {
    read(idPrefixes) {
      const found: PostingText[] = [];
      for (const prefix of new Set(idPrefixes)) {
        if (prefix === "") continue;
        const matches = postings.filter((posting) => posting.id.startsWith(prefix));
        // Exactly one, or none: an ambiguous prefix names no posting in particular.
        const only = matches.length === 1 ? matches[0] : undefined;
        if (only !== undefined) found.push(only);
      }
      return Promise.resolve(found);
    },
  };
}

/** A cache in memory, for tests and for a local run. */
export function createMemoryAnswerCache(): AnswerCache & { readonly size: () => number } {
  const held = new Map<string, string>();
  const key = (criterionId: string, model: string, contentHash: string) =>
    `${criterionId}\u0000${model}\u0000${contentHash}`;
  return {
    read(criterionId, model, contentHashes) {
      const found: CachedAnswer[] = [];
      for (const contentHash of contentHashes) {
        const answerJson = held.get(key(criterionId, model, contentHash));
        if (answerJson !== undefined) found.push({ contentHash, answerJson });
      }
      return Promise.resolve(found);
    },
    write(criterionId, model, answers) {
      for (const answer of answers) {
        held.set(key(criterionId, model, answer.contentHash), answer.answerJson);
      }
      return Promise.resolve();
    },
    size: () => held.size,
  };
}
