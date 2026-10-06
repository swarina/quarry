/**
 * The secret that lets this browser ask its own questions, held in memory and nowhere else.
 *
 * Asking spends money, so the criterion path is closed behind a shared secret (ADR-0027). That
 * secret has to reach the browser somehow, and every durable place to put it is worse than
 * typing it again:
 *
 * - The URL is the search state, and it is in the URL precisely so that it can be copied,
 *   bookmarked and shared (ADR-0023). A secret there would be shared along with the search, and
 *   would sit in browser history and in any referrer that escaped.
 * - `localStorage` outlives the tab, the window and the person using the machine.
 * - `sessionStorage` is narrower but still survives reload and still lands on disk.
 *
 * A module-level variable survives exactly as long as the page does, and the page never
 * navigates: switching region or using the back button both go through the router rather than a
 * reload, so in ordinary use this is typed once. A real reload loses it, which is the cost, and
 * it is a small one against a key that spends money being left on a shared machine.
 *
 * Nothing here writes to any storage, and the value is never returned raw: callers get the
 * header or nothing, so a secret cannot be rendered into the page by accident.
 */
let secret: string | undefined;

/**
 * Shortest secret accepted, matching the floor `criteriaSecret()` holds the server to. Checking
 * it here turns a truncated paste into a message beside the box rather than a 401 after a round
 * trip. It is not a security control: the server is what decides whether a secret is right.
 */
const MIN_LENGTH = 24;

export class NotUnlockedError extends Error {
  override readonly name = "NotUnlockedError";
}

/**
 * Holds a secret for this page's lifetime. Rejects one too short to be the server's, so a
 * mistyped or truncated paste is caught here rather than as a 401 after a round trip.
 */
export function unlock(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_LENGTH) {
    throw new NotUnlockedError(`a secret is at least ${MIN_LENGTH} characters`);
  }
  secret = trimmed;
}

/** Forgets the secret. The page keeps working; only asking stops. */
export function lock(): void {
  secret = undefined;
}

export function unlocked(): boolean {
  return secret !== undefined;
}

/**
 * The `Authorization` header value, or throws. Deliberately the only way out: the secret itself
 * is never handed back, so it cannot end up in the DOM, in the URL, or in a log line.
 */
export function authorization(): string {
  if (secret === undefined) throw new NotUnlockedError("no secret has been given");
  return `Bearer ${secret}`;
}
