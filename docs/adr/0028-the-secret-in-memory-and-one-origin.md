# ADR-0028: Keep the secret in memory, and serve asking from one origin

- Status: accepted
- Date: 2026-10-06

## Context

ADR-0027 closed the criterion path behind a shared secret and left the browser out of it: the
path was reachable with `curl` and nothing else. Putting a question box on the site raises two
questions that path never had to answer, because until now no browser held the secret and no page
called the endpoint.

They are worth deciding together, because they are the same question asked twice: what can get at
a credential that spends money.

**Where the secret lives.** It has to reach the browser to be sent, and every place to keep it is
a place it can be read from. The site has no accounts and no server to hold a session (ADR-0023),
so there is nothing to exchange it for.

**How the page reaches the endpoint.** The site is static files; the criterion path is a program.
They can be one origin or two, and two means a CORS policy on an endpoint that spends money.

## Options

**The secret:**

1. **In memory only.** Gone on reload, never written anywhere, cannot be read back out of the
   page. Costs a re-type per reload.
2. **`sessionStorage`.** Survives reload, scoped to the tab. Still written to disk by the
   browser, and still readable by anything running on the origin.
3. **`localStorage`.** Survives everything, including the person who used the machine before.
4. **In the URL.** No, and worth writing down as refused rather than silently not done: the URL is
   the search state precisely so it can be copied, bookmarked and shared (ADR-0023), so a secret
   there is a secret shared on purpose. It would also sit in history and in any referrer that
   escaped.

**The origin:**

1. **One origin**: serve the built site and the criterion path from the same host, which in
   development is `pipeline serve-criteria --site <dist>` and in a deployment is the Worker
   serving both.
2. **Two origins with a CORS allowlist**: the site on its host, the path on another, naming the
   site's origin in `Access-Control-Allow-Origin`.
3. **Two origins with a permissive policy.** Refused on sight. A money-spending endpoint that
   answers any origin is one that any page can spend from, with a credential the browser is
   holding.

## Decision

**Option 1 for both: the secret in memory only, and one origin.**

- The secret lives in a module-level variable in `credentials.ts` and nowhere else. Nothing in
  that module touches any storage API, and the value is never handed back raw: callers get the
  `Authorization` header or an error, so it cannot be rendered into the page, logged, or put in a
  URL by accident. A test holds it to this by trapping `localStorage` and `sessionStorage` and
  asserting neither is touched.
- The box holding it is emptied the moment the secret is taken, and a "Forget the secret" button
  clears it without reloading.
- The page and the criterion path are served from one origin, so there is no CORS policy at all.
  The site's existing `connect-src 'self'` is then sufficient on its own: the page may call back
  to the host it came from and nowhere else, so even a successful injection has nowhere to send
  the secret.
- The criterion routes are matched before the static files, so a file on disk can never shadow
  `/criteria/ask`.
- The policy itself lives in one module shared by both servers (`@quarry/site/static`), because
  a second copy would drift, and the copy that drifted would be the one serving the page that
  holds a secret.

The cost of in-memory is one re-type per reload, which is smaller than it sounds: the site never
navigates. Switching region and the back button both go through the router, so in ordinary use
the secret is typed once per visit.

## Consequences

- A reload loses the secret and the answers, and keeps the question, because the question is in
  the URL and the answers are not. Asking again is free, since the server caches on the wording
  (ADR-0024), so the recovery from a reload costs a re-type and a few seconds rather than money.
- The deployment has one more constraint than it had: the Worker must serve the site and the
  criterion path together, or the page cannot reach it under its own policy. That is a real
  restriction on how it gets deployed, and it is the restriction that removes CORS from the
  design entirely.
- The feature stays unshareable, as ADR-0027 already accepted. A browser is now one of the things
  that can ask, but only a browser whose user was given the secret.
- `apps/pipeline` now depends on `@quarry/site` for the static server. An app depending on an app
  is unusual here, and the alternative was two copies of a security header.
- This says nothing about the public version. When the path opens to people without a secret,
  none of this applies: that design needs per-IP quotas, a global cap and a visible cost estimate,
  and it should be made once the cost model has been seen in real use.
