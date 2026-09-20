# OpsFlow Security Requirements

## 1. Secrets

Never commit:
- API keys
- database passwords
- Redis passwords
- session tokens
- webhook secrets
- private credentials

Use `.env` locally and commit only `.env.example`.

## 2. Passwords

Use a modern password hashing function such as:
- Argon2id
- scrypt

Never use plain SHA hashing for passwords.

Phase 1 uses Node's `scrypt` with a random 16-byte salt and a 64-byte derived
key. Password hashes are never returned by the API. Registration requires a
12–128 character password. Login uses the same public error for unknown email
and wrong password and performs a costly hash for unknown email too.

## 3. Sessions

Session tokens should:
- use secure random values
- be stored hashed in the database
- use HTTP-only cookies
- use SameSite protections
- support explicit logout
- expire

Production deployments must use secure cookies over HTTPS.

Phase 1 sessions use 32 random bytes in an opaque cookie. PostgreSQL stores
only the SHA-256 token hash. Sessions expire after seven days, are deleted on
logout, and update `last_seen_at` when more than five minutes old. The cookie
is HTTP-only, SameSite=Lax, path `/`, and Secure when `NODE_ENV=production`.
The web app uses a same-origin `/api` proxy in local development. Mutation
requests with an `Origin` header must match `WEB_ORIGIN`. Before a public
deployment, review CSRF protection, HTTPS, cookie domain, reverse proxy, and
rate limiting for the chosen hosting topology.

## 4. Authorization

Authentication is not authorization.

Every organization-scoped resource must verify membership.

Sensitive actions should verify role.

Phase 1 organization reads require current-user membership in the API. Role
changes require owner status. A transaction locks the organization row while
checking owner count, preventing concurrent demotions from removing its last
owner.

## 5. Webhook Security

Future production webhook protections should include:
- secret tokens
- signature verification where supported
- rate limiting
- payload size limits
- replay or idempotency protection

## 6. HTTP Action Security

The HTTP request workflow action creates SSRF risk.

Before production deployment:
- block localhost
- block private IP ranges
- block cloud metadata addresses
- restrict unsafe protocols
- use request timeout
- limit redirects
- limit response size

For early local MVP, HTTP actions may be restricted to explicit safe demo endpoints.

## 7. Logging

Logs must not expose:
- passwords
- session tokens
- API keys
- raw authorization headers

Sensitive values should be redacted.

## 8. AI Inputs

If AI providers are added:
- do not automatically send secrets
- document what data leaves the application
- validate structured AI outputs
- never treat model output as trusted executable code

## 9. Dependency Security

Use:
- lockfiles
- automated dependency checks
- GitHub Dependabot where useful

## 10. Security Before Deployment

Before public deployment, review:
- CORS
- CSRF
- cookie security
- rate limits
- webhook abuse
- SSRF
- environment secrets
- database privileges
- error exposure
- request limits
