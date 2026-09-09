# ADR 0008: Hosted platform direction — WorkOS, Convex, Vercel, javelind

Date: 2026-09-09. Status: accepted (decision record; implementation is a later priority).

## Context
javelin.run is the hosted forge/control plane. Building custom user/password auth was on the v1 blocker list; that is no longer the plan.

## Decision
- **WorkOS** provides identity: users, sessions, organizations, SSO/SCIM.
- **Convex** holds control-plane data and authorization (repos metadata, contributions, review, policy config).
- **Vercel** hosts the javelin.run frontend/web product.
- **javelind** remains a separate repository data plane; hosted Javelin grants it signed, scoped access tokens derived from WorkOS-backed identity.
- Static bearer tokens remain only as a documented self-host/dev mode.
- WorkOS solves identity, not web security: request limits, CSRF/CSP/security headers, rate limiting, audit events, and secure secret handling are still ours to implement.
- TLS terminates at the platform/reverse proxy; plain HTTP is acceptable only on localhost/dev.

## Consequences
- The current experimental web app is not the javelin.run architecture; it is a local forge client over JRP and stays useful for self-host.
- No custom auth code is written in this repo beyond the dev-mode bearer token.
- Remote agent and third-party harness ingestion must authenticate with signed scoped tokens, not shared static ones.
