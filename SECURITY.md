# Security policy

## Supported branch

- `main`

## Reporting

For non-sensitive bugs, open a normal GitHub issue.

For sensitive issues, do not post tokens, session data, or reproducible auth bypass details in a public issue. Contact the repository owner privately and include:

- affected command or file
- impact
- reproduction prerequisites
- whether Lovable credentials, local browser profiles, or deployed apps are exposed

## Secret-handling expectations

- Never commit seeded browser profiles.
- Never commit session cookies or auth exports.
- Never commit `.env` files with real credentials.
- Treat Lovable desktop session imports as sensitive local state.
- Prefer test or throwaway projects for write-path validation.
