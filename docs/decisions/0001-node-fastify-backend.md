# ADR-0001: Use a Node.js Fastify backend for Obsidian Core

- Status: accepted
- Date: 2026-07-26
- Owners: Obsidian Core

## Context

Obsidian Core needs a backend-only modular-monolith foundation. The user selected Node.js as the preferred runtime. Future Vercel-hosted interfaces consume authenticated Core APIs.

## Decision

Use Node.js with strict TypeScript and Fastify for `apps/core-api`. The API exposes no GUI and owns business rules, authorization, audit behavior, and authoritative records. Fastify's application instance is separate from its listener to support HTTP-boundary tests. Zod validates environment variables at startup.

## Consequences

Future browser and mobile applications must use authenticated Core APIs rather than direct database access or duplicated business logic. The initial API contains only an unauthenticated health endpoint; protected APIs wait for identity, authorization, audit, and database foundations.
