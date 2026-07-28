# ADR-0002: Use versioned SQL migrations for the database foundation

- Status: accepted
- Date: 2026-07-28
- Owners: Obsidian Core

## Context

Core needs a reviewable, deterministic PostgreSQL foundation before domain repositories and service interfaces exist.

## Decision

Use ordered SQL files applied by a Node.js migration runner. The runner records an identifier and SHA-256 checksum, rejects checksum drift, and applies the migration and its record in one transaction.

## Consequences

Migrations are explicit, database-native, and append-only. Persistence abstractions remain deferred until domain modules need them.
