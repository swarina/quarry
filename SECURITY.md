# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security** tab, then **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. You will get an
acknowledgement within three business days and updates as the report is investigated.

## Scope

- The code in this repository.
- Any deployment of it operated by the maintainers.

Security fixes are made on `main`; there are no separately maintained release branches.

## Handling of secrets and personal data

- API keys and tokens live only in local `.env` files, GitHub Actions environments, and
  Cloudflare Worker secrets. They are never committed.
- Resume content is processed in the user's browser. Nothing personal is stored server-side.
